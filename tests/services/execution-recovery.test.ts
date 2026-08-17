import { describe, expect, it, vi } from 'vitest';
import type { ExecutionAttempt, ExecutionAttemptStatus } from '../../src/database/types.js';
import { ExecutionRecoveryService } from '../../src/services/execution-recovery-service.js';

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const hash = `0x${'a'.repeat(64)}`;
const attempt = (status: ExecutionAttemptStatus, overrides: Partial<ExecutionAttempt & { externalChainId: number }> = {}) => ({
  id: '1', proposalId: '2', sourceTransactionHash: `0x${'b'.repeat(64)}`, destinationWallet: walletA, chainId: '3', externalChainId: 999,
  status, copyTransactionHash: null, nonce: '5', gasEstimate: '100', nativeValue: '1', failureReason: null, retryCount: 0, executionStartedAt: new Date(), ...overrides,
});

function setup(candidates: Array<ExecutionAttempt & { externalChainId: number }>, clientOverrides: Record<string, unknown> = {}) {
  const transitions: Array<[string, string, unknown]> = [];
  const attempts = {
    listRecoveryCandidates: vi.fn(async () => candidates),
    transition: vi.fn(async (id: string, status: string, fields?: unknown) => { transitions.push([id, status, fields]); return { id, status }; }),
    reconcile: vi.fn(async () => undefined),
  };
  const client = { getReceipt: vi.fn(async () => null), getTransaction: vi.fn(async () => null), getLatestNonce: vi.fn(async () => 5), getPendingNonce: vi.fn(async () => 5), ...clientOverrides };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new ExecutionRecoveryService(attempts as never, () => client as never, logger as never, 60_000);
  return { service, attempts, client, transitions };
}

describe('ExecutionRecoveryService', () => {
  it.each(['CLAIMED', 'SIMULATING'] as const)('safely retries a provably pre-sign %s crash', async (status) => {
    const test = setup([attempt(status)]); await test.service.recoverNow();
    expect(test.transitions[0]?.[1]).toBe('RETRY'); expect(test.client.getReceipt).not.toHaveBeenCalled();
  });
  it.each(['SIGNING', 'SIGNED'] as const)('quarantines a hashless %s crash without retrying', async (status) => {
    const test = setup([attempt(status)]); await test.service.recoverNow();
    expect(test.transitions[0]?.[1]).toBe('UNKNOWN'); expect(test.client.getReceipt).not.toHaveBeenCalled();
  });
  it('quarantines an unknown broadcast outcome without a hash', async () => {
    const test = setup([attempt('BROADCASTING')]); await test.service.recoverNow(); expect(test.transitions[0]?.[1]).toBe('UNKNOWN');
  });
  it('recovers a known transaction hash as SUBMITTED when visible', async () => {
    const test = setup([attempt('BROADCASTING', { copyTransactionHash: hash })], { getTransaction: vi.fn(async () => ({ blockNumber: null })) });
    await test.service.recoverNow(); expect(test.transitions[0]?.[1]).toBe('SUBMITTED');
  });
  it.each([['success', true], ['reverted', false]] as const)('reconciles a %s receipt', async (status, confirmed) => {
    const receipt = { status, blockNumber: 10n, gasUsed: 2n, effectiveGasPrice: 3n };
    const test = setup([attempt('BROADCASTING', { copyTransactionHash: hash })], { getReceipt: vi.fn(async () => receipt) });
    await test.service.recoverNow(); expect(test.attempts.reconcile).toHaveBeenCalledWith(hash, expect.objectContaining({ confirmed }));
  });
  it('does not automatically reclaim RETRY during recovery', async () => {
    const test = setup([attempt('RETRY')]); await test.service.recoverNow(); expect(test.attempts.transition).not.toHaveBeenCalled();
  });
  it('uses pending and latest nonce evidence but remains fail closed', async () => {
    const test = setup([attempt('BROADCASTING', { copyTransactionHash: hash })], { getLatestNonce: vi.fn(async () => 5), getPendingNonce: vi.fn(async () => 6) });
    await test.service.recoverNow(); expect(test.transitions[0]?.[1]).toBe('UNKNOWN'); expect(JSON.stringify(test.transitions[0]?.[2])).toContain('consumed by a pending transaction');
  });
  it('does not create duplicate work for UNKNOWN attempts', async () => {
    const test = setup([attempt('UNKNOWN')]); await test.service.recoverNow(); expect(test.attempts.transition).not.toHaveBeenCalled();
  });
  it('reconciles multiple attempts and destination wallets independently', async () => {
    const test = setup([attempt('SIGNING'), attempt('BROADCASTING', { id: '2', destinationWallet: walletB, copyTransactionHash: hash })], { getTransaction: vi.fn(async () => ({ blockNumber: null })) });
    await test.service.recoverNow(); expect(test.transitions.map((entry) => entry[1])).toEqual(['UNKNOWN', 'SUBMITTED']);
  });
  it('becomes ready only after startup recovery completes', async () => {
    const test = setup([]); expect(test.service.isReady()).toBe(false); await test.service.start(); expect(test.service.isReady()).toBe(true); test.service.stop(); expect(test.service.isReady()).toBe(false);
  });
});
