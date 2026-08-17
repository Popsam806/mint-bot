import type { ExecutionAttemptRepository } from '../database/repositories/execution-attempt-repository.js';

export interface CopyTransactionReceipt {
  transactionHash: string; blockNumber: bigint; status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint;
}
export class CopyTransactionReconciler {
  constructor(private readonly attempts: ExecutionAttemptRepository) {}
  async reconcile(receipt: CopyTransactionReceipt): Promise<void> {
    await this.attempts.reconcile(receipt.transactionHash, { confirmed: receipt.status === 'success', blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
  }
}
