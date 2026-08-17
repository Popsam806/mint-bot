import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import type { CopyTransactionProposal, UserExecutionSettings } from '../../src/database/types.js';
import { ExecutionPolicy, type ExecutionPolicyContext } from '../../src/services/execution-policy.js';
import { AutomaticTransactionExecutor } from '../../src/services/transaction-executor.js';
import { DestinationNonceManager } from '../../src/services/destination-nonce-manager.js';
import { CopyTransactionReconciler } from '../../src/services/copy-transaction-reconciler.js';
import { PendingAutomaticExecutionService } from '../../src/services/pending-automatic-execution-service.js';

const destination = '0x0000000000000000000000000000000000000022';
const target = '0x0000000000000000000000000000000000000033';
const sourceHash = `0x${'a'.repeat(64)}`;
const copyHash = `0x${'b'.repeat(64)}`;
const proposal = (overrides: Partial<CopyTransactionProposal> = {}): CopyTransactionProposal => ({
  id: '7', userId: '42', detectedMintId: '1', sourceTransactionHash: sourceHash, destinationWallet: destination,
  chainId: '1', strategy: 'PUBLIC_MINT', eligibilityStatus: 'ELIGIBLE', targetContract: target, calldata: '0x1234',
  nativeValue: '10', gasLimit: '100000', simulationStatus: 'SUCCESS', simulationError: null, proposalStatus: 'READY',
  confidence: 'HIGH', executionStatus: 'READY', expiresAt: new Date(Date.now() + 60_000), explanation: 'ready',
  createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const settings = (overrides: Partial<UserExecutionSettings> = {}): UserExecutionSettings => ({
  userId: '42', executionMode: 'AUTO', destinationWallet: destination, allowedChains: ['1'], allowedContracts: [target],
  maxNativeValue: '100', maxGas: '200000', maxQuantity: '3', proposalExpirationSeconds: 600,
  autoRetryEnabled: false, createdAt: new Date(), updatedAt: new Date(), ...overrides,
});
const policyContext = (overrides: Partial<ExecutionPolicyContext> = {}): ExecutionPolicyContext => ({
  proposal: proposal(), settings: settings(), monitoredSourceEnabled: true, chainEnabled: true, destinationOwned: true,
  sourceStatus: 'PENDING', sourceCurrent: true, alreadyExecuted: false, quantity: 1n, contractAddress: target,
  gasEstimate: 100000n, ...overrides,
});

describe('ExecutionPolicy', () => {
  const policy = new ExecutionPolicy();
  it('allows a fully valid AUTO execution', () => expect(policy.evaluate(policyContext()).decision).toBe('EXECUTE'));
  it('rejects disabled AUTO mode', () => expect(policy.evaluate(policyContext({ settings: settings({ executionMode: 'DISABLED' }) })).decision).toBe('SKIP'));
  it('rejects an unallowed chain', () => expect(policy.evaluate(policyContext({ settings: settings({ allowedChains: ['9'] }) })).reason).toContain('Chain'));
  it('rejects an unallowed contract', () => expect(policy.evaluate(policyContext({ settings: settings({ allowedContracts: [destination] }) })).reason).toContain('Contract'));
  it('rejects quantity over the limit', () => expect(policy.evaluate(policyContext({ quantity: 4n })).reason).toContain('quantity'));
  it('rejects native value over the limit', () => expect(policy.evaluate(policyContext({ proposal: proposal({ nativeValue: '101' }) })).reason).toContain('Native'));
  it('rejects gas over the limit', () => expect(policy.evaluate(policyContext({ gasEstimate: 200001n })).reason).toContain('Gas'));
  it('rejects unsupported calldata', () => expect(policy.evaluate(policyContext({ proposal: proposal({ strategy: 'UNKNOWN', proposalStatus: 'UNSUPPORTED' }) })).decision).toBe('SKIP'));
  it('rejects unknown eligibility', () => expect(policy.evaluate(policyContext({ proposal: proposal({ eligibilityStatus: 'ELIGIBILITY_UNKNOWN' }) })).decision).toBe('SKIP'));
  it.each(['REPLACED', 'DROPPED', 'INVALIDATED', 'REVERTED'] as const)('rejects a %s source transaction', (sourceStatus) => expect(policy.evaluate(policyContext({ sourceStatus })).decision).toBe('SKIP'));
  it('expires stale proposals', () => expect(policy.evaluate(policyContext({ proposal: proposal({ expiresAt: new Date(0) }) })).decision).toBe('EXPIRED'));
});

function setup(options: { simulation?: { success: true } | { success: false; error: string }; signerAddress?: string; broadcastError?: Error; claim?: boolean; retry?: boolean; gasError?: Error } = {}) {
  const value = proposal(); const configured = settings({ autoRetryEnabled: options.retry ?? false });
  const context = { monitoredSourceEnabled: true, chainEnabled: true, sourceStatus: 'PENDING', sourceCurrent: true,
    quantity: 1n, contractAddress: target, pendingDetectedAt: new Date(), analysisStartedAt: new Date(), analysisCompletedAt: new Date() };
  const transitions: string[] = [];
  const attempts = { claim: vi.fn(async () => options.claim === false ? null : ({ id: '99' })), transition: vi.fn(async (_id: string, status: string) => { transitions.push(status); return { id: '99', status }; }), reconcile: vi.fn(async () => undefined) };
  const proposals = { findById: vi.fn(async () => value), changeExecutionStatus: vi.fn(async () => value) };
  const signer = { getAddress: vi.fn(async () => options.signerAddress ?? destination), signTransaction: vi.fn(async () => `0x${'1'.repeat(200)}`) };
  const client = { simulate: vi.fn(async () => options.simulation ?? { success: true as const }), estimateGas: options.gasError ? vi.fn(async () => { throw options.gasError; }) : vi.fn(async () => 110000n),
    getPendingNonce: vi.fn(async () => 5), estimateFees: vi.fn(async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n })),
    broadcast: options.broadcastError ? vi.fn(async () => { throw options.broadcastError; }) : vi.fn(async () => copyHash) };
  const executor = new AutomaticTransactionExecutor(proposals as never, { getOrCreate: vi.fn(async () => configured) } as never,
    { load: vi.fn(async () => context) } as never, attempts as never, signer, () => ({ chainId: 999, client }), new ExecutionPolicy(), new DestinationNonceManager());
  return { executor, value, attempts, transitions, signer, client, context, proposals };
}

describe('AutomaticTransactionExecutor', () => {
  it('re-simulates, signs, and broadcasts a valid transaction', async () => {
    const test = setup(); const result = await test.executor.execute(test.value);
    expect(result.transactionHash).toBe(copyHash); expect(test.client.simulate).toHaveBeenCalled();
    expect(test.signer.signTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 5, chainId: 999, gas: 110000n }));
    expect(test.transitions).toEqual(['SIMULATING', 'SIGNING', 'SIGNED', 'SUBMITTED']);
    expect(JSON.stringify(test.attempts.transition.mock.calls, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(`0x${'1'.repeat(200)}`);
  });
  it('does not sign after failed fresh simulation', async () => { const test = setup({ simulation: { success: false, error: 'wallet limit' } }); await expect(test.executor.execute(test.value)).rejects.toThrow('not signed'); expect(test.signer.signTransaction).not.toHaveBeenCalled(); });
  it('fails closed on signer address mismatch', async () => { const test = setup({ signerAddress: target }); await expect(test.executor.execute(test.value)).rejects.toThrow('does not match'); expect(test.signer.signTransaction).not.toHaveBeenCalled(); });
  it('persists a broadcast failure without blind retry', async () => { const test = setup({ broadcastError: new Error('insufficient funds') }); await expect(test.executor.execute(test.value)).rejects.toThrow('insufficient funds'); expect(test.transitions.at(-1)).toBe('FAILED'); });
  it('prevents duplicate execution when the durable claim is held', async () => { const test = setup({ claim: false }); await expect(test.executor.execute(test.value)).rejects.toThrow('already claimed'); expect(test.signer.signTransaction).not.toHaveBeenCalled(); });
  it('places a pre-sign RPC failure into RETRY when configured', async () => { const test = setup({ gasError: new Error('temporary RPC failure'), retry: true }); await expect(test.executor.execute(test.value)).rejects.toThrow('temporary'); expect(test.transitions.at(-1)).toBe('RETRY'); expect(test.signer.signTransaction).not.toHaveBeenCalled(); });
  it('treats an already-known broadcast as submitted', async () => { const test = setup({ broadcastError: new Error('already known') }); await expect(test.executor.execute(test.value)).resolves.toMatchObject({ attemptId: '99' }); expect(test.transitions.at(-1)).toBe('SUBMITTED'); });
  it('is restart-idempotent through the durable claim', async () => { const first = setup(); await first.executor.execute(first.value); const restarted = setup({ claim: false }); await expect(restarted.executor.execute(restarted.value)).rejects.toThrow('already claimed'); });
});

describe('nonce serialization and reconciliation', () => {
  it('serializes concurrent operations for one destination wallet', async () => {
    const manager = new DestinationNonceManager(); const events: string[] = [];
    const first = manager.serialize(1, destination, async () => { events.push('first-start'); await new Promise((resolve) => setTimeout(resolve, 10)); events.push('first-end'); });
    const second = manager.serialize(1, destination, async () => { events.push('second-start'); events.push('second-end'); });
    await Promise.all([first, second]); expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
  it('allows different destination wallets to execute concurrently', async () => {
    const manager = new DestinationNonceManager(); const events: string[] = [];
    await Promise.all([manager.serialize(1, destination, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); events.push('a'); }), manager.serialize(1, target, async () => { events.push('b'); })]);
    expect(events[0]).toBe('b');
  });
  it('reconciles confirmed and reverted copy transactions', async () => {
    const reconcile = vi.fn(async () => undefined); const service = new CopyTransactionReconciler({ reconcile } as never);
    await service.reconcile({ transactionHash: copyHash, blockNumber: 10n, status: 'success', gasUsed: 1n, effectiveGasPrice: 2n });
    await service.reconcile({ transactionHash: sourceHash, blockNumber: 11n, status: 'reverted', gasUsed: 3n, effectiveGasPrice: 4n });
    expect(reconcile).toHaveBeenNthCalledWith(1, copyHash, expect.objectContaining({ confirmed: true }));
    expect(reconcile).toHaveBeenNthCalledWith(2, sourceHash, expect.objectContaining({ confirmed: false }));
  });
});

describe('pending AUTO pipeline', () => {
  const calldata = encodeFunctionData({ abi: parseAbi(['function mint(uint256 quantity) payable']), functionName: 'mint', args: [2n] });
  const transaction = { id: 'tx-1', chainId: '1', transactionHash: sourceHash, inputData: calldata, toAddress: target, transactionValue: '10' };
  const monitored = { id: 'm-1', userId: '42', chainId: '1', walletAddress: '0x0000000000000000000000000000000000000011', enabled: true, createdAt: new Date(), updatedAt: new Date() };
  const chain = { id: 999, name: 'Test EVM' };
  function pendingSetup(mode: UserExecutionSettings['executionMode'] = 'AUTO') {
    const created = proposal({ detectedMintId: null, detectedTransactionId: 'tx-1', mintQuantity: '2' });
    const proposals = { createIfAbsent: vi.fn(async () => created) }; const executor = { execute: vi.fn(async () => ({ transactionHash: copyHash, submittedAt: new Date() })) };
    const client = { simulate: vi.fn(async () => ({ success: true as const })), estimateGas: vi.fn(async () => 100000n) };
    const service = new PendingAutomaticExecutionService({ getOrCreate: vi.fn(async () => settings({ executionMode: mode })) } as never,
      proposals as never, () => client as never, executor, { info: vi.fn(), warn: vi.fn() } as never);
    return { service, proposals, executor, client };
  }
  it('builds and executes a supported pending public mint without Telegram', async () => {
    const test = pendingSetup(); await test.service.onPending(transaction, monitored, chain as never);
    expect(test.proposals.createIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ mintQuantity: '2', detectedTransactionId: 'tx-1' }));
    expect(test.executor.execute).toHaveBeenCalledTimes(1);
  });
  it('does nothing when AUTO mode is disabled', async () => { const test = pendingSetup('DISABLED'); await test.service.onPending(transaction, monitored, chain as never); expect(test.executor.execute).not.toHaveBeenCalled(); });
  it('does not guess unsupported pending calldata', async () => { const test = pendingSetup(); await test.service.onPending({ ...transaction, inputData: '0xdeadbeef' }, monitored, chain as never); expect(test.client.simulate).not.toHaveBeenCalled(); expect(test.executor.execute).not.toHaveBeenCalled(); });
});
