import type { Logger } from 'pino';
import type { DetectedTransactionRepository } from '../database/repositories/detected-transaction-repository.js';
import type { DetectedTransaction, MonitoredAddress } from '../database/types.js';
import { analyzeMintCalldata } from '../blockchain/decoders/mint-calldata-strategies.js';
import type { PendingAnalysisHook } from '../blockchain/listeners/pending-monitoring-engine.js';

export class PendingCalldataClassifier implements PendingAnalysisHook {
  constructor(private readonly transactions: DetectedTransactionRepository, private readonly logger: Logger) {}
  async onPending(value: unknown, monitored: MonitoredAddress): Promise<void> {
    const transaction = value as DetectedTransaction;
    const startedAt = new Date();
    const result = analyzeMintCalldata(transaction.inputData as `0x${string}`, monitored.walletAddress, monitored.walletAddress);
    const completedAt = new Date();
    await this.transactions.markAnalysisTiming(transaction.id, startedAt, completedAt);
    this.logger.info({ transactionHash: transaction.transactionHash, strategy: result.strategy, analysisLatencyMs: completedAt.getTime() - startedAt.getTime() }, 'Pending calldata classified');
  }
}
