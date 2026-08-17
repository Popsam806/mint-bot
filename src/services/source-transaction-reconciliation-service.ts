import type { Logger } from 'pino';
import type { ExecutionClient } from '../blockchain/clients/execution-client.js';
import type { DetectedTransactionRepository } from '../database/repositories/detected-transaction-repository.js';

export class SourceTransactionReconciliationService {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly transactions: DetectedTransactionRepository, private readonly clients: (chainId: number) => ExecutionClient,
    private readonly logger: Logger, private readonly intervalMs = 15_000) {}
  async start(): Promise<void> { if (this.running) return; this.running = true; await this.reconcileNow(); this.schedule(); }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); }
  async reconcileNow(): Promise<void> {
    for (const transaction of await this.transactions.listMinedForReconciliation()) {
      try {
        const receipt = await this.clients(transaction.externalChainId).getReceipt(transaction.transactionHash);
        if (!receipt) { await this.transactions.markReorged(transaction.transactionHash); this.logger.warn({ chainId: transaction.externalChainId, transactionHash: transaction.transactionHash }, 'Mined source transaction removed by reorg'); }
        else if (receipt.status === 'reverted') await this.transactions.markMined(transaction.transactionHash, receipt.blockNumber, true);
      } catch (error) { this.logger.warn({ chainId: transaction.externalChainId, transactionHash: transaction.transactionHash, error }, 'Source reconciliation RPC check failed'); }
    }
  }
  private schedule(): void { if (this.running) this.timer = setTimeout(() => void this.reconcileNow()
    .catch((error) => this.logger.warn({ error }, 'Source reconciliation scan failed')).finally(() => this.schedule()), this.intervalMs); }
}
