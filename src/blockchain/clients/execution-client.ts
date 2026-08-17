import type { PublicClient } from 'viem';
import type { ProposalRequest } from './transaction-analysis-provider.js';

export interface ExecutionClient {
  simulate(request: ProposalRequest): Promise<{ success: true } | { success: false; error: string }>;
  estimateGas(request: ProposalRequest): Promise<bigint>;
  getPendingNonce(address: string): Promise<number>;
  getLatestNonce(address: string): Promise<number>;
  getTransaction(transactionHash: string): Promise<{ blockNumber: bigint | null } | null>;
  getReceipt(transactionHash: string): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null>;
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
  getLatestNonce(address: string): Promise<number> { return this.client.getTransactionCount({ address: address as `0x${string}`, blockTag: 'latest' }); }
  async getTransaction(transactionHash: string): Promise<{ blockNumber: bigint | null } | null> {
    try { const transaction = await this.client.getTransaction({ hash: transactionHash as `0x${string}` }); return { blockNumber: transaction.blockNumber }; }
    catch (error) { return this.isNotFound(error) ? null : Promise.reject(error); }
  }
  async getReceipt(transactionHash: string): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
      return { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
    } catch (error) { return this.isNotFound(error) ? null : Promise.reject(error); }
  }
  async estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }> {
    try {
      const fees = await this.client.estimateFeesPerGas();
      if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    } catch { /* Legacy EVM chains may not expose EIP-1559 fee history. */ }
    return { gasPrice: await this.client.getGasPrice() };
  }
  broadcast(signedTransaction: string): Promise<string> { return this.client.sendRawTransaction({ serializedTransaction: signedTransaction as `0x${string}` }); }
  private isNotFound(error: unknown): boolean { return error instanceof Error && /not found|could not be found/i.test(error.message); }
}
