import type { PublicClient } from 'viem';
import type { ChainBlockProvider, MinedBlock } from './types.js';

export class ViemBlockProvider implements ChainBlockProvider {
  constructor(private readonly httpClient: PublicClient, private readonly websocketClient?: PublicClient) {}
  getBlockNumber(): Promise<bigint> { return this.httpClient.getBlockNumber(); }
  async getBlock(blockNumber: bigint): Promise<MinedBlock> {
    const block = await this.httpClient.getBlock({ blockNumber, includeTransactions: true });
    return {
      number: block.number,
      transactions: block.transactions.filter((transaction) => typeof transaction !== 'string').map((transaction) => ({
        hash: transaction.hash, from: transaction.from, to: transaction.to, value: transaction.value, input: transaction.input,
        gas: transaction.gas, gasPrice: transaction.gasPrice ?? null,
        effectiveGasPrice: 'effectiveGasPrice' in transaction && typeof transaction.effectiveGasPrice === 'bigint' ? transaction.effectiveGasPrice : null,
      })),
    };
  }
  async getTransactionReceiptStatus(transactionHash: string): Promise<'success' | 'reverted'> {
    return (await this.httpClient.getTransactionReceipt({ hash: transactionHash as `0x${string}` })).status;
  }
  watchBlockNumbers(onBlock: (blockNumber: bigint) => void, onError: (error: unknown) => void): () => void {
    if (!this.websocketClient) throw new Error('WebSocket provider is unavailable');
    return this.websocketClient.watchBlockNumber({ emitOnBegin: true, onBlockNumber: onBlock, onError });
  }
}
