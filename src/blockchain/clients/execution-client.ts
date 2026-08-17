import type { PublicClient } from 'viem';
import type { ProposalRequest } from './transaction-analysis-provider.js';

export interface ExecutionClient {
  simulate(request: ProposalRequest): Promise<{ success: true } | { success: false; error: string }>;
  estimateGas(request: ProposalRequest): Promise<bigint>;
  getPendingNonce(address: string): Promise<number>;
  estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }>;
  broadcast(signedTransaction: string): Promise<string>;
}

export class ViemExecutionClient implements ExecutionClient {
  constructor(private readonly client: PublicClient) {}
  async simulate(request: ProposalRequest): Promise<{ success: true } | { success: false; error: string }> {
    try { await this.client.call({ account: request.from as `0x${string}`, to: request.to as `0x${string}`, data: request.data, value: request.value }); return { success: true }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Simulation reverted' }; }
  }
  estimateGas(request: ProposalRequest): Promise<bigint> { return this.client.estimateGas({ account: request.from as `0x${string}`, to: request.to as `0x${string}`, data: request.data, value: request.value }); }
  getPendingNonce(address: string): Promise<number> { return this.client.getTransactionCount({ address: address as `0x${string}`, blockTag: 'pending' }); }
  async estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }> {
    try {
      const fees = await this.client.estimateFeesPerGas();
      if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    } catch { /* Legacy EVM chains may not expose EIP-1559 fee history. */ }
    return { gasPrice: await this.client.getGasPrice() };
  }
  broadcast(signedTransaction: string): Promise<string> { return this.client.sendRawTransaction({ serializedTransaction: signedTransaction as `0x${string}` }); }
}
