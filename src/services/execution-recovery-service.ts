import type { Logger } from 'pino';
import type { ExecutionClient } from '../blockchain/clients/execution-client.js';
import type { ExecutionAttempt } from '../database/types.js';
import type { ExecutionAttemptRepository } from '../database/repositories/execution-attempt-repository.js';
import type { DestinationWalletLock } from './destination-wallet-lock.js';
import { LocalDestinationWalletLock } from './destination-wallet-lock.js';

export class ExecutionRecoveryService {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private ready = false;
  constructor(
    private readonly attempts: ExecutionAttemptRepository,
    private readonly clients: (externalChainId: number) => ExecutionClient,
    private readonly logger: Logger,
    private readonly intervalMs = 5_000,
    private readonly walletLock: DestinationWalletLock = new LocalDestinationWalletLock(),
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.recoverNow(); this.ready = true; this.schedule(); }
    catch (error) { this.running = false; this.ready = false; throw error; }
  }
  stop(): void { this.running = false; this.ready = false; if (this.timer) clearTimeout(this.timer); }
  isReady(): boolean { return this.ready; }
  async recoverNow(): Promise<void> {
    const candidates = await this.attempts.listRecoveryCandidates();
    for (const attempt of candidates) {
      await this.walletLock.withLock(attempt.externalChainId, attempt.destinationWallet, async () => this.recoverAttempt(attempt))
        .catch((error) => this.logger.warn({ attemptId: attempt.id, error }, 'Execution recovery attempt failed'));
    }
  }
  async recoverAttemptById(id: string): Promise<void> {
    const attempt = await this.attempts.findById(id);
    if (attempt) await this.walletLock.withLock(attempt.externalChainId, attempt.destinationWallet, async () => this.recoverAttempt(attempt));
  }
  private async recoverAttempt(attempt: ExecutionAttempt & { externalChainId: number }): Promise<void> {
    if (attempt.status === 'RETRY') return;
    if (attempt.status === 'CLAIMED' || attempt.status === 'SIMULATING') {
      await this.attempts.transition(attempt.id, 'RETRY', { failureReason: 'Recovered after a crash before signing began', retry: true });
      return;
    }
    if (!attempt.copyTransactionHash) {
      const client = this.clients(attempt.externalChainId);
      const [latestNonce, pendingNonce] = await Promise.all([client.getLatestNonce(attempt.destinationWallet), client.getPendingNonce(attempt.destinationWallet)]);
      await this.markUnknown(attempt, `Signing or broadcast outcome is ambiguous and no transaction hash is available; ${this.nonceEvidence(attempt, latestNonce, pendingNonce)}`);
      return;
    }
    const client = this.clients(attempt.externalChainId);
    const receipt = await client.getReceipt(attempt.copyTransactionHash);
    if (receipt) {
      await this.attempts.reconcile(attempt.copyTransactionHash, { confirmed: receipt.status === 'success', blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
      return;
    }
    const transaction = await client.getTransaction(attempt.copyTransactionHash);
    if (transaction) {
      if (attempt.status !== 'SUBMITTED') await this.attempts.transition(attempt.id, 'SUBMITTED');
      return;
    }
    if (attempt.status === 'SUBMITTED') return;
    const [latestNonce, pendingNonce] = await Promise.all([client.getLatestNonce(attempt.destinationWallet), client.getPendingNonce(attempt.destinationWallet)]);
    await this.markUnknown(attempt, `Transaction hash is not visible; ${this.nonceEvidence(attempt, latestNonce, pendingNonce)}`);
  }
  private async markUnknown(attempt: ExecutionAttempt, reason: string): Promise<void> {
    if (attempt.status === 'UNKNOWN') return;
    await this.attempts.transition(attempt.id, 'UNKNOWN', { failureReason: reason });
  }
  private nonceEvidence(attempt: ExecutionAttempt, latestNonce: number, pendingNonce: number): string {
    const recordedNonce = attempt.nonce === null ? null : Number(attempt.nonce);
    return recordedNonce === null ? 'recorded nonce is unavailable'
      : latestNonce > recordedNonce ? 'recorded nonce is already mined'
        : pendingNonce > recordedNonce ? 'recorded nonce is consumed by a pending transaction' : 'recorded nonce is not visible on chain';
  }
  private schedule(): void {
    if (this.running) this.timer = setTimeout(() => void this.recoverNow()
      .catch((error) => this.logger.warn({ error }, 'Execution recovery scan failed'))
      .finally(() => this.schedule()), this.intervalMs);
  }
}
