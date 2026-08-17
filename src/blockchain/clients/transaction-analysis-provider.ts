import type { PublicClient } from 'viem';

export interface SourceTransaction {
  hash: string; chainId: number | null; from: string; to: string | null; value: bigint; input: `0x${string}`;
  gas: bigint; gasPrice: bigint | null; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null; type: string;
}
export interface ProposalRequest { from: string; to: string; data: `0x${string}`; value: bigint; }
export interface TransactionAnalysisProvider {
  getTransaction(hash: string): Promise<SourceTransaction>;
  estimateGas(request: ProposalRequest): Promise<bigint>;
  simulate(request: ProposalRequest): Promise<{ success: true } | { success: false; error: string }>;
}

export class ViemTransactionAnalysisProvider implements TransactionAnalysisProvider {
  constructor(private readonly client: PublicClient) {}
  async getTransaction(hash: string): Promise<SourceTransaction> {
    const transaction = await this.client.getTransaction({ hash: hash as `0x${string}` });
    return { hash: transaction.hash, chainId: transaction.chainId ?? null, from: transaction.from, to: transaction.to, value: transaction.value, input: transaction.input, gas: transaction.gas, gasPrice: transaction.gasPrice ?? null, maxFeePerGas: transaction.maxFeePerGas ?? null, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? null, type: transaction.type };
  }
  estimateGas(request: ProposalRequest): Promise<bigint> {
    return this.client.estimateGas({ account: request.from as `0x${string}`, to: request.to as `0x${string}`, data: request.data, value: request.value });
  }
  async simulate(request: ProposalRequest): Promise<{ success: true } | { success: false; error: string }> {
    try {
      await this.client.call({ account: request.from as `0x${string}`, to: request.to as `0x${string}`, data: request.data, value: request.value });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Simulation reverted' };
    }
  }
}
