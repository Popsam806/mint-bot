import { describe, expect, it, vi } from 'vitest';
import { ChainMonitor } from '../../src/blockchain/listeners/chain-monitor.js';
import type { ChainBlockProvider, MinedBlock } from '../../src/blockchain/listeners/types.js';
import type { MonitoredAddress } from '../../src/database/types.js';

const address = (id: string, walletAddress: string, enabled = true): MonitoredAddress => ({ id, userId: '1', chainId: '10', walletAddress, enabled, createdAt: new Date(), updatedAt: new Date() });
const block = (number: bigint, from: string, hash: string): MinedBlock => ({ number, transactions: [{ hash, from, to: '0x0000000000000000000000000000000000000002', value: 5n, input: '0x1234', gas: 21_000n, gasPrice: 2n, effectiveGasPrice: 2n }] });
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function setup(blocks: MinedBlock[]) {
  let head = blocks.at(-1)?.number ?? 0n;
  const provider: ChainBlockProvider = { getBlockNumber: vi.fn(async () => head), getBlock: vi.fn(async (number) => blocks.find((item) => item.number === number) ?? { number, transactions: [] }), watchBlockNumbers: vi.fn(() => vi.fn()) };
  const saved: bigint[] = [];
  const transactions = { createIfAbsent: vi.fn(async (input) => ({ ...input, transactionHash: input.transactionHash })), markMined: vi.fn(async () => undefined) };
  const checkpoints = { get: vi.fn(async () => saved.at(-1) ?? 0n), save: vi.fn(async (_chain: string, number: bigint) => { saved.push(number); }) };
  const monitor = new ChainMonitor({ databaseChainId: '10', externalChainId: 10, chainName: 'Test', provider, hasWebSocket: false, getAddresses: () => [address('1', '0x0000000000000000000000000000000000000001'), address('2', '0x0000000000000000000000000000000000000003', false)], transactions: transactions as never, checkpoints: checkpoints as never, logger, confirmations: 0n, pollingIntervalMs: 10_000 });
  return { monitor, provider, transactions, checkpoints, saved, setHead: (next: bigint) => { head = next; } };
}

describe('generic EVM chain monitor', () => {
  it('filters sender transactions and persists matching transactions', async () => {
    const test = setup([block(1n, '0x0000000000000000000000000000000000000001', '0x' + 'a'.repeat(64)), block(2n, '0x0000000000000000000000000000000000000003', '0x' + 'b'.repeat(64))]);
    await test.monitor.start(); await test.monitor.stop();
    expect(test.transactions.createIfAbsent).toHaveBeenCalledTimes(1);
    expect(test.transactions.createIfAbsent.mock.calls[0]?.[0].monitoredAddressId).toBe('1');
    expect(test.saved).toEqual([1n, 2n]);
  });

  it('resumes from the last processed block without reprocessing it', async () => {
    const test = setup([block(1n, '0x0000000000000000000000000000000000000001', '0x' + 'a'.repeat(64)), block(2n, '0x0000000000000000000000000000000000000001', '0x' + 'b'.repeat(64))]);
    await test.monitor.start(); await test.monitor.stop();
    test.setHead(3n);
    await test.monitor.start(); await test.monitor.stop();
    expect(test.provider.getBlock).toHaveBeenCalledWith(3n);
  });

  it('uses websocket notifications and invokes reconnection handling on failure', async () => {
    let onError: ((error: unknown) => void) | undefined;
    const test = setup([]);
    test.provider.watchBlockNumbers = vi.fn((_onBlock, error) => { onError = error; return vi.fn(); });
    const monitor = new ChainMonitor({ databaseChainId: '10', externalChainId: 10, chainName: 'Test', provider: test.provider, hasWebSocket: true, getAddresses: () => [], transactions: test.transactions as never, checkpoints: test.checkpoints as never, logger, confirmations: 0n, reconnectDelayMs: 1, pollingIntervalMs: 1 });
    await monitor.start(); onError?.(new Error('disconnect')); await new Promise((resolve) => setTimeout(resolve, 5)); await monitor.stop();
    expect(test.provider.watchBlockNumbers).toHaveBeenCalled();
  });

  it('does not classify a reverted monitored source transaction', async () => {
    const test = setup([block(1n, '0x0000000000000000000000000000000000000001', '0x' + 'f'.repeat(64))]); test.provider.getTransactionReceiptStatus = vi.fn(async () => 'reverted');
    await test.monitor.start(); await test.monitor.stop();
    expect(test.transactions.markMined).toHaveBeenCalledWith(expect.any(String), expect.any(BigInt), true);
    expect(test.transactions.createIfAbsent).not.toHaveBeenCalled();
  });

  it('supports independent monitors for multiple chains', async () => {
    const first = setup([block(1n, '0x0000000000000000000000000000000000000001', '0x' + 'd'.repeat(64))]);
    const second = setup([block(1n, '0x0000000000000000000000000000000000000001', '0x' + 'e'.repeat(64))]);
    await Promise.all([first.monitor.start(), second.monitor.start()]);
    await Promise.all([first.monitor.stop(), second.monitor.stop()]);
    expect(first.transactions.createIfAbsent).toHaveBeenCalledTimes(1);
    expect(second.transactions.createIfAbsent).toHaveBeenCalledTimes(1);
  });
});
