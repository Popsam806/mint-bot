import { describe, expect, it, vi } from 'vitest';
import { PendingMonitoringEngine } from '../../src/blockchain/listeners/pending-monitoring-engine.js';
import { ViemPendingTransactionProvider } from '../../src/blockchain/listeners/viem-pending-provider.js';
import type { PendingObservation, PendingSourceTransaction, PendingTransactionProvider } from '../../src/blockchain/listeners/pending-transaction-provider.js';

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const tx = (hash: string, from = walletA, nonce = 1n): PendingSourceTransaction => ({ hash, from, to: walletB, nonce, value: 1n, input: '0x1234', gas: 21_000n, gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null });

describe('pending provider capability detection', () => {
  it('reports explicitly configured unsupported state', async () => expect(await new ViemPendingTransactionProvider({} as never, undefined, 'unsupported').detectCapability()).toBe('unsupported'));
  it('does not claim websocket capability without a websocket client', async () => expect(await new ViemPendingTransactionProvider({} as never, undefined, 'websocket').detectCapability()).toBe('unsupported'));
  it('subscribes to pending hashes when websocket capability is configured', async () => {
    const watchPendingTransactions = vi.fn(({ onTransactions }) => { onTransactions(['0x' + 'a'.repeat(64)]); return vi.fn(); });
    const provider = new ViemPendingTransactionProvider({} as never, { watchPendingTransactions } as never, 'websocket');
    const observed = vi.fn(); await provider.subscribe(observed, vi.fn());
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('uses pending filter changes when filter capability is configured', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce('0x1')
      .mockResolvedValueOnce(['0x' + 'b'.repeat(64)]);
    const provider = new ViemPendingTransactionProvider({ request } as never, undefined, 'filter');

    const observations = await provider.poll();

    expect(request).toHaveBeenNthCalledWith(1, { method: 'eth_newPendingTransactionFilter', params: [] });
    expect(request).toHaveBeenNthCalledWith(2, { method: 'eth_getFilterChanges', params: ['0x1'] });
    expect(observations).toHaveLength(1);
  });

  it('can poll after a websocket subscription failure', async () => {
    const hash = '0x' + 'c'.repeat(64);
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('filters unsupported'))
      .mockResolvedValueOnce([hash]);
    const provider = new ViemPendingTransactionProvider({ request } as never, {} as never, 'websocket');

    await expect(provider.poll()).resolves.toMatchObject([{ hash }]);
  });
});

class FakeProvider implements PendingTransactionProvider {
  constructor(private readonly observations: PendingObservation[], private readonly transactions: Map<string, PendingSourceTransaction>, private readonly mode: 'websocket' | 'polling' | 'unsupported' = 'websocket') {}
  async detectCapability() { return this.mode; }
  async subscribe(onObservation: (observation: PendingObservation) => void) { for (const item of this.observations) onObservation(item); return vi.fn(); }
  async poll() { return this.observations; }
  async getTransaction(hash: string) { return this.transactions.get(hash) ?? null; }
}

describe('PendingMonitoringEngine', () => {
  it('reconnects a failed pending WebSocket while polling remains available', async () => {
    let disconnect: ((error: unknown) => void) | undefined; const subscribe = vi.fn(async (_handler, onError) => { disconnect = onError; return vi.fn(); });
    const provider = { detectCapability: async () => 'websocket' as const, subscribe, poll: vi.fn(async () => []), getTransaction: vi.fn(async () => null) };
    const config = { id: 1, name: 'Chain 1', pendingTransactionMode: 'websocket' }; const repository = { upsertPending: vi.fn(), markDroppedBefore: vi.fn(async () => 0) };
    const engine = new PendingMonitoringEngine({ getConfiguredChains: () => [config] } as never, { listEnabledByChain: async () => [{ id: '1', userId: '1', chainId: '1', walletAddress: walletA, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '1' }] } as never,
      repository as never, { info: vi.fn(), warn: vi.fn() } as never, () => provider, undefined, { reconnectDelayMs: 1, pollingIntervalMs: 1, dropTimeoutMs: 100_000 });
    await engine.start(); disconnect?.(new Error('closed')); await new Promise((resolve) => setTimeout(resolve, 10)); await engine.stop(); expect(subscribe.mock.calls.length).toBeGreaterThan(1);
  });

  it('bounds the pending hash cache and can reconsider evicted observations', async () => {
    const hashes = ['a', 'b', 'c'].map((value) => `0x${value.repeat(64)}`); let emit: ((value: PendingObservation) => void) | undefined;
    const provider = { detectCapability: async () => 'websocket' as const, subscribe: async (handler: (value: PendingObservation) => void) => { emit = handler; return vi.fn(); }, poll: async () => [], getTransaction: async (hash: string) => tx(hash) };
    const repository = { upsertPending: vi.fn(async ({ transaction }) => ({ ...transaction, transactionHash: transaction.hash, inputData: transaction.input, ingestedAt: new Date() })), markDroppedBefore: vi.fn(async () => 0) };
    const config = { id: 1, name: 'Chain 1', pendingTransactionMode: 'websocket' };
    const engine = new PendingMonitoringEngine({ getConfiguredChains: () => [config] } as never, { listEnabledByChain: async () => [{ id: '1', userId: '1', chainId: '1', walletAddress: walletA, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '1' }] } as never,
      repository as never, { info: vi.fn(), warn: vi.fn() } as never, () => provider, undefined, { maxSeenHashes: 2, dropTimeoutMs: 100_000 });
    await engine.start(); for (const hash of hashes) emit?.({ hash, observedAt: new Date(), provider: 'test' }); emit?.({ hash: hashes[0]!, observedAt: new Date(), provider: 'test' }); await new Promise((resolve) => setTimeout(resolve, 10)); await engine.stop();
    expect(repository.upsertPending).toHaveBeenCalledTimes(4);
  });
  it('filters senders, deduplicates hashes, and handles multiple wallets/chains', async () => {
    const hashA = '0x' + 'a'.repeat(64); const hashB = '0x' + 'b'.repeat(64); const hashIgnored = '0x' + 'c'.repeat(64);
    const providers = new Map<number, FakeProvider>([
      [1, new FakeProvider([{ hash: hashA, observedAt: new Date(), provider: 'one' }, { hash: hashA, observedAt: new Date(), provider: 'one' }, { hash: hashIgnored, observedAt: new Date(), provider: 'one' }], new Map([[hashA, tx(hashA, walletA)], [hashIgnored, tx(hashIgnored, walletB)]]))],
      [2, new FakeProvider([{ hash: hashB, observedAt: new Date(), provider: 'two' }], new Map([[hashB, tx(hashB, walletB)]]))],
    ]);
    const configs = [1, 2].map((id) => ({ id, name: `Chain ${id}`, pendingTransactionMode: 'websocket' }));
    const addresses = [{ id: '1', userId: '1', chainId: '10', walletAddress: walletA, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '1' }, { id: '2', userId: '1', chainId: '20', walletAddress: walletB, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '2' }];
    const repository = { upsertPending: vi.fn(async ({ transaction, monitoredAddressId, chainId }) => ({ id: transaction.hash, transactionHash: transaction.hash, inputData: transaction.input, ingestedAt: new Date(), monitoredAddressId, chainId })), markDroppedBefore: vi.fn(async () => 0) };
    const hook = { onPending: vi.fn(async () => undefined) };
    const engine = new PendingMonitoringEngine({ getConfiguredChains: () => configs } as never, { listEnabledByChain: async () => addresses } as never, repository as never, { info: vi.fn(), warn: vi.fn() } as never, (config) => providers.get(config.id)!, hook, { refreshIntervalMs: 100_000, dropTimeoutMs: 100_000 });
    await engine.start(); await new Promise((resolve) => setTimeout(resolve, 10)); await engine.stop();
    expect(repository.upsertPending).toHaveBeenCalledTimes(2);
    expect(hook.onPending).toHaveBeenCalledTimes(2);
  });

  it('keeps an unsupported chain explicit without processing', async () => {
    const repository = { upsertPending: vi.fn(), markDroppedBefore: vi.fn(async () => 0) };
    const config = { id: 1, name: 'Unsupported', pendingTransactionMode: 'unsupported' };
    const engine = new PendingMonitoringEngine({ getConfiguredChains: () => [config] } as never, { listEnabledByChain: async () => [{ id: '1', userId: '1', chainId: '1', walletAddress: walletA, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '1' }] } as never, repository as never, { info: vi.fn(), warn: vi.fn() } as never, () => new FakeProvider([], new Map(), 'unsupported'), undefined, { dropTimeoutMs: 100_000 });
    await engine.start(); await engine.stop(); expect(repository.upsertPending).not.toHaveBeenCalled();
  });

  it('stops considering a removed wallet immediately after refresh', async () => {
    const hash = '0x' + 'd'.repeat(64); let emit: ((observation: PendingObservation) => void) | undefined;
    const provider: PendingTransactionProvider = {
      detectCapability: async () => 'websocket',
      subscribe: async (handler) => { emit = handler; return vi.fn(); },
      poll: async () => [],
      getTransaction: async () => tx(hash, walletA),
    };
    let enabled = [{ id: '1', userId: '1', chainId: '10', walletAddress: walletA, enabled: true, createdAt: new Date(), updatedAt: new Date(), externalChainId: '1' }];
    const repository = { upsertPending: vi.fn(), markDroppedBefore: vi.fn(async () => 0) };
    const config = { id: 1, name: 'Chain 1', pendingTransactionMode: 'websocket' };
    const engine = new PendingMonitoringEngine({ getConfiguredChains: () => [config] } as never, { listEnabledByChain: async () => enabled } as never, repository as never, { info: vi.fn(), warn: vi.fn() } as never, () => provider, undefined, { refreshIntervalMs: 100_000, dropTimeoutMs: 100_000 });
    await engine.start(); enabled = []; await engine.refreshNow();
    emit?.({ hash, observedAt: new Date(), provider: 'test' }); await new Promise((resolve) => setTimeout(resolve, 0));
    await engine.stop(); expect(repository.upsertPending).not.toHaveBeenCalled();
  });
});
