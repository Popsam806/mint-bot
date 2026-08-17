import { beforeEach, describe, expect, it, vi } from 'vitest';

const queues = new Map<string, { jobs: Map<string, unknown>; closed: boolean }>();
const workers = new Map<string, { processor: (job: never) => Promise<unknown>; closed: boolean }>();

vi.mock('bullmq', () => ({
  Queue: class {
    readonly state: { jobs: Map<string, unknown>; closed: boolean };
    constructor(readonly name: string) { this.state = queues.get(name) ?? { jobs: new Map(), closed: false }; queues.set(name, this.state); }
    async add(name: string, data: unknown, options: { jobId?: string } = {}) { const id = options.jobId ?? `${name}-${this.state.jobs.size}`; if (!this.state.jobs.has(id)) this.state.jobs.set(id, { id, name, data }); return this.state.jobs.get(id); }
    async close() { this.state.closed = true; }
  },
  Worker: class {
    readonly state: { processor: (job: never) => Promise<unknown>; closed: boolean };
    constructor(readonly name: string, processor: (job: never) => Promise<unknown>) { this.state = { processor, closed: false }; workers.set(name, this.state); }
    on() { return this; }
    async waitUntilReady() { return this; }
    async close() { this.state.closed = true; }
  },
}));

import { BackgroundWorkerService, QUEUE_NAMES } from '../../src/queue/background-workers.js';

const baseAttempt = { id: '10', proposalId: '20', sourceTransactionHash: `0x${'a'.repeat(64)}`, destinationWallet: '0x0000000000000000000000000000000000000011',
  chainId: '3', externalChainId: 999, status: 'RETRY', copyTransactionHash: null, nonce: '1', gasEstimate: '1', nativeValue: '0', failureReason: null, retryCount: 1, executionStartedAt: new Date() };
const proposal = { id: '20', executionStatus: 'READY' };

function setup(workItems: unknown[] = []) {
  const attempts = { listWorkItems: vi.fn(async () => workItems), findById: vi.fn(async () => baseAttempt), transition: vi.fn(async () => baseAttempt) };
  const proposals = { findById: vi.fn(async () => proposal), listReadyWithoutAttempt: vi.fn(async () => []) };
  const executor = { execute: vi.fn(async () => ({ transactionHash: '0x1', submittedAt: new Date() })) };
  const recovery = { recoverAttemptById: vi.fn(async () => undefined) };
  const confirmation = { reconcileHash: vi.fn(async () => true) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new BackgroundWorkerService({} as never, attempts as never, proposals as never, executor, recovery as never, confirmation as never, logger as never);
  return { service, attempts, proposals, executor, recovery, confirmation, logger };
}
const job = (id: string, data: unknown) => ({ id, data, timestamp: Date.now() - 5, attemptsMade: 0 });

describe('BackgroundWorkerService', () => {
  beforeEach(() => { queues.clear(); workers.clear(); });

  it('enqueues initial execution with a deterministic duplicate-safe job ID', async () => {
    const test = setup(); await test.service.enqueueInitial('20'); await test.service.enqueueInitial('20');
    expect(queues.get(QUEUE_NAMES.execution)?.jobs.size).toBe(1);
  });

  it('requeues PostgreSQL retry, recovery, and confirmation work on startup', async () => {
    const retry = { ...baseAttempt }; const unknown = { ...baseAttempt, id: '11', status: 'UNKNOWN' }; const submitted = { ...baseAttempt, id: '12', status: 'SUBMITTED', copyTransactionHash: `0x${'b'.repeat(64)}` };
    const test = setup([retry, unknown, submitted]); await test.service.start();
    expect(queues.get(QUEUE_NAMES.execution)?.jobs.has('execute-retry-10')).toBe(true);
    expect(queues.get(QUEUE_NAMES.recovery)?.jobs.has('recover-11')).toBe(true);
    expect(queues.get(QUEUE_NAMES.recovery)?.jobs.has('recover-12')).toBe(true);
    expect(queues.get(QUEUE_NAMES.confirmation)?.jobs.has('confirm-12')).toBe(true); await test.service.stop();
  });

  it('recreates a missed initial job from an authoritative PostgreSQL proposal', async () => {
    const test = setup(); test.proposals.listReadyWithoutAttempt.mockResolvedValueOnce([proposal]); await test.service.start();
    expect(queues.get(QUEUE_NAMES.execution)?.jobs.has('execute-initial-20')).toBe(true); await test.service.stop();
  });

  it('executes an explicitly RETRY attempt through the existing executor', async () => {
    const test = setup(); await test.service.start();
    await workers.get(QUEUE_NAMES.execution)?.processor(job('retry', { kind: 'retry', proposalId: '20', attemptId: '10' }) as never);
    expect(test.executor.execute).toHaveBeenCalledWith(proposal); await test.service.stop();
  });

  it.each(['UNKNOWN', 'SUBMITTED', 'CONFIRMED'])('abandons stale retry work in %s state', async (status) => {
    const test = setup(); test.attempts.findById.mockResolvedValueOnce({ ...baseAttempt, status }); await test.service.start();
    await workers.get(QUEUE_NAMES.execution)?.processor(job('retry', { kind: 'retry', proposalId: '20', attemptId: '10' }) as never);
    expect(test.executor.execute).not.toHaveBeenCalled(); await test.service.stop();
  });

  it('enforces a durable retry ceiling', async () => {
    const test = setup(); test.attempts.findById.mockResolvedValueOnce({ ...baseAttempt, retryCount: 5 }); await test.service.start();
    await workers.get(QUEUE_NAMES.execution)?.processor(job('retry', { kind: 'retry', proposalId: '20', attemptId: '10' }) as never);
    expect(test.attempts.transition).toHaveBeenCalledWith('10', 'FAILED', expect.any(Object)); expect(test.executor.execute).not.toHaveBeenCalled(); await test.service.stop();
  });

  it('dispatches recovery jobs without converting UNKNOWN into execution retries', async () => {
    const test = setup(); await test.service.start();
    await workers.get(QUEUE_NAMES.recovery)?.processor(job('recover', { attemptId: '10' }) as never);
    expect(test.recovery.recoverAttemptById).toHaveBeenCalledWith('10'); expect(test.executor.execute).not.toHaveBeenCalled(); await test.service.stop();
  });

  it('reconciles a submitted confirmation job', async () => {
    const test = setup(); test.attempts.findById.mockResolvedValueOnce({ ...baseAttempt, status: 'SUBMITTED', copyTransactionHash: `0x${'c'.repeat(64)}` }); await test.service.start();
    await workers.get(QUEUE_NAMES.confirmation)?.processor(job('confirm', { attemptId: '10' }) as never);
    expect(test.confirmation.reconcileHash).toHaveBeenCalled(); await test.service.stop();
  });

  it('throws for a temporarily invisible submitted transaction so BullMQ applies backoff', async () => {
    const test = setup(); test.attempts.findById.mockResolvedValueOnce({ ...baseAttempt, status: 'SUBMITTED', copyTransactionHash: `0x${'c'.repeat(64)}` }); test.confirmation.reconcileHash.mockResolvedValueOnce(false); await test.service.start();
    await expect(workers.get(QUEUE_NAMES.confirmation)?.processor(job('confirm', { attemptId: '10' }) as never)).rejects.toThrow('not yet visible'); await test.service.stop();
  });

  it('stops all workers and queues gracefully', async () => {
    const test = setup(); await test.service.start(); await test.service.stop();
    expect([...workers.values()].every((value) => value.closed)).toBe(true); expect([...queues.values()].every((value) => value.closed)).toBe(true);
  });
});
