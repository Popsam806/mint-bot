import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { ExecutionAttemptRepository } from '../database/repositories/execution-attempt-repository.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';
import type { TransactionExecutor } from '../services/transaction-executor.js';
import type { ExecutionRecoveryService } from '../services/execution-recovery-service.js';
import type { CopyTransactionConfirmationEngine } from '../blockchain/listeners/copy-transaction-confirmation-engine.js';
import type { ExecutionDispatcher } from '../services/pending-automatic-execution-service.js';
import { createQueue } from './queue-factory.js';

export const QUEUE_NAMES = { execution: 'execution-retry', recovery: 'execution-recovery', confirmation: 'copy-confirmation' } as const;
const MAX_DURABLE_RETRIES = 5;
type ExecutionJob = { proposalId: string; kind: 'initial' | 'retry'; attemptId?: string };
type AttemptJob = { attemptId: string };

export class BackgroundWorkerService implements ExecutionDispatcher {
  private readonly executionQueue: Queue<ExecutionJob>;
  private readonly recoveryQueue: Queue<AttemptJob>;
  private readonly confirmationQueue: Queue<AttemptJob>;
  private workers: Array<Worker> = [];
  private ready = false;
  private stopped = false;
  private scanTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly connection: Redis,
    private readonly attempts: ExecutionAttemptRepository,
    private readonly proposals: CopyTransactionProposalRepository,
    private readonly executor: TransactionExecutor,
    private readonly recovery: ExecutionRecoveryService,
    private readonly confirmation: CopyTransactionConfirmationEngine,
    private readonly logger: Logger,
    private readonly concurrency = 2,
    private readonly onChainResolved?: (databaseChainId: string, externalChainId: number) => void,
  ) {
    this.executionQueue = createQueue(QUEUE_NAMES.execution, connection) as Queue<ExecutionJob>;
    this.recoveryQueue = createQueue(QUEUE_NAMES.recovery, connection) as Queue<AttemptJob>;
    this.confirmationQueue = createQueue(QUEUE_NAMES.confirmation, connection) as Queue<AttemptJob>;
  }
  isReady(): boolean { return this.ready && !this.stopped; }
  async start(): Promise<void> {
    if (this.isReady()) return;
    this.stopped = false;
    this.workers = [
      new Worker<ExecutionJob>(QUEUE_NAMES.execution, (job) => this.processExecution(job), { connection: this.connection, concurrency: this.concurrency }),
      new Worker<AttemptJob>(QUEUE_NAMES.recovery, (job) => this.processRecovery(job), { connection: this.connection, concurrency: this.concurrency }),
      new Worker<AttemptJob>(QUEUE_NAMES.confirmation, (job) => this.processConfirmation(job), { connection: this.connection, concurrency: this.concurrency }),
    ];
    try {
      for (const worker of this.workers) {
        worker.on('error', (error) => this.logger.warn({ error }, 'Background worker error'));
        worker.on('failed', (job, error) => {
          const terminal = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
          this.logger.warn({ event: terminal ? 'job_failed' : 'job_retried', queue: worker.name, jobId: job?.id, attemptsMade: job?.attemptsMade, error }, terminal ? 'Background job failed permanently' : 'Background job failed; BullMQ will apply configured retry policy');
        });
      }
      await Promise.all(this.workers.map((worker) => worker.waitUntilReady()));
      await this.requeueFromPostgres();
      this.ready = true; this.scheduleScan();
      this.logger.info({ queues: Object.values(QUEUE_NAMES), concurrency: this.concurrency }, 'Background workers ready');
    } catch (error) { await Promise.allSettled(this.workers.map((worker) => worker.close())); this.workers = []; this.ready = false; throw error; }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.ready = false;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([this.executionQueue.close(), this.recoveryQueue.close(), this.confirmationQueue.close()]);
    this.workers = [];
  }
  async enqueueInitial(proposalId: string): Promise<void> {
    await this.executionQueue.add('execute', { proposalId, kind: 'initial' }, { jobId: `execute-initial-${proposalId}` });
    this.logger.info({ event: 'job_enqueued', queue: QUEUE_NAMES.execution, jobId: `execute-initial-${proposalId}` }, 'Background job enqueued');
  }
  async enqueueRetry(proposalId: string, attemptId: string): Promise<void> {
    const jobId = `execute-retry-${attemptId}`; await this.executionQueue.add('retry', { proposalId, kind: 'retry', attemptId }, { jobId });
    this.logger.info({ event: 'job_enqueued', queue: QUEUE_NAMES.execution, jobId }, 'Background job enqueued');
  }
  async enqueueRecovery(attemptId: string): Promise<void> {
    const jobId = `recover-${attemptId}`; await this.recoveryQueue.add('recover', { attemptId }, { jobId });
    this.logger.info({ event: 'job_enqueued', queue: QUEUE_NAMES.recovery, jobId }, 'Background job enqueued');
  }
  async enqueueConfirmation(attemptId: string): Promise<void> {
    const jobId = `confirm-${attemptId}`; await this.confirmationQueue.add('confirm', { attemptId }, { jobId });
    this.logger.info({ event: 'job_enqueued', queue: QUEUE_NAMES.confirmation, jobId }, 'Background job enqueued');
  }
  private async requeueFromPostgres(): Promise<void> {
    for (const proposal of await this.proposals.listReadyWithoutAttempt()) await this.enqueueInitial(proposal.id);
    for (const attempt of await this.attempts.listWorkItems()) {
      if (attempt.status === 'RETRY') await this.enqueueRetry(attempt.proposalId, attempt.id);
      else if (['SIGNING', 'SIGNED', 'BROADCASTING', 'UNKNOWN'].includes(attempt.status)) await this.enqueueRecovery(attempt.id);
      else if (attempt.status === 'SUBMITTED' && attempt.copyTransactionHash) { await this.enqueueRecovery(attempt.id); await this.enqueueConfirmation(attempt.id); }
    }
  }
  private async processExecution(job: Job<ExecutionJob>): Promise<void> {
    const started = Date.now(); this.logger.info({ event: 'job_started', queue: QUEUE_NAMES.execution, jobId: job.id, queueLatencyMs: Math.max(0, started - job.timestamp) }, 'Background job started');
    const attempt = (job.data.kind === 'retry' && job.data.attemptId) ? await this.attempts.findById(job.data.attemptId) : null;
    if (job.data.kind === 'retry' && (!attempt || attempt.status !== 'RETRY')) { this.logger.info({ event: 'job_abandoned', jobId: job.id }, 'Background retry abandoned as stale'); return; }
    if (attempt && attempt.retryCount >= MAX_DURABLE_RETRIES) { await this.attempts.transition(attempt.id, 'FAILED', { failureReason: 'Durable execution retry limit exceeded' }); this.logger.warn({ event: 'job_abandoned', jobId: job.id, attemptId: attempt.id }, 'Background retry abandoned after durable retry limit'); return; }
    if (attempt) this.onChainResolved?.(attempt.chainId, attempt.externalChainId);
    const proposal = await this.proposals.findById(job.data.proposalId);
    if (!proposal) { this.logger.warn({ event: 'job_abandoned', jobId: job.id }, 'Background execution abandoned; proposal missing'); return; }
    if (['SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REJECTED'].includes(proposal.executionStatus)) { this.logger.info({ event: 'job_abandoned', jobId: job.id, proposalId: proposal.id }, 'Background execution abandoned as stale'); return; }
    await this.executor.execute(proposal);
    this.logger.info({ event: 'job_completed', queue: QUEUE_NAMES.execution, jobId: job.id, workerLatencyMs: Date.now() - started }, 'Background job completed');
  }
  private async processRecovery(job: Job<AttemptJob>): Promise<void> {
    const started = Date.now(); this.logger.info({ event: 'job_started', queue: QUEUE_NAMES.recovery, jobId: job.id, queueLatencyMs: Math.max(0, started - job.timestamp) }, 'Background job started');
    await this.recovery.recoverAttemptById(job.data.attemptId);
    this.logger.info({ event: 'job_completed', queue: QUEUE_NAMES.recovery, jobId: job.id, workerLatencyMs: Date.now() - started }, 'Background job completed');
  }
  private async processConfirmation(job: Job<AttemptJob>): Promise<void> {
    const started = Date.now(); this.logger.info({ event: 'job_started', queue: QUEUE_NAMES.confirmation, jobId: job.id, queueLatencyMs: Math.max(0, started - job.timestamp) }, 'Background job started');
    const attempt = await this.attempts.findById(job.data.attemptId);
    if (!attempt || attempt.status !== 'SUBMITTED' || !attempt.copyTransactionHash) return;
    if (!await this.confirmation.reconcileHash(attempt.copyTransactionHash, attempt.externalChainId)) throw new Error('Submitted transaction is not yet visible');
    this.logger.info({ event: 'job_completed', queue: QUEUE_NAMES.confirmation, jobId: job.id, workerLatencyMs: Date.now() - started }, 'Background job completed');
  }
  private scheduleScan(): void {
    if (!this.stopped) this.scanTimer = setTimeout(() => void this.requeueFromPostgres()
      .catch((error) => this.logger.warn({ error }, 'PostgreSQL background-work scan failed'))
      .finally(() => this.scheduleScan()), 5_000);
  }
}
