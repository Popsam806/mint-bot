import type { Logger } from 'pino';
import type { EvmChainManager } from '../clients/evm-chain-manager.js';
import type { ExecutionAttemptRepository } from '../../database/repositories/execution-attempt-repository.js';

export class CopyTransactionConfirmationEngine {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(private readonly chains: EvmChainManager, private readonly attempts: ExecutionAttemptRepository, private readonly logger: Logger, private readonly intervalMs = 3_000) {}
  async start(): Promise<void> { if (this.running) return; this.running = true; await this.tick(); }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); }
  async reconcileHash(transactionHash: string, externalChainId: number): Promise<boolean> {
    try {
      const receipt = await this.chains.getPublicClient(externalChainId).getTransactionReceipt({ hash: transactionHash as `0x${string}` });
      await this.attempts.reconcile(transactionHash, { confirmed: receipt.status === 'success', blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
      return true;
    } catch (error) {
      if (!/not found|could not be found/i.test(error instanceof Error ? error.message : String(error))) throw error;
      return false;
    }
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const pending = await this.attempts.listAwaitingConfirmation();
      await Promise.all(pending.map(async ({ transactionHash, externalChainId }) => {
        try {
          const receipt = await this.chains.getPublicClient(externalChainId).getTransactionReceipt({ hash: transactionHash as `0x${string}` });
          await this.attempts.reconcile(transactionHash, { confirmed: receipt.status === 'success', blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
          this.logger.info({ chainId: externalChainId, transactionHash, status: receipt.status }, 'Copy transaction reconciled');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not found|could not be found/i.test(message)) this.logger.warn({ chainId: externalChainId, transactionHash, error }, 'Copy transaction receipt lookup failed');
        }
      }));
    } catch (error) { this.logger.warn({ error }, 'Copy transaction confirmation scan failed'); }
    finally { if (this.running) this.timer = setTimeout(() => void this.tick(), this.intervalMs); }
  }
}
