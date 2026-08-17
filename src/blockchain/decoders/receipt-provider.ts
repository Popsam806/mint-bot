import type { PublicClient } from 'viem';
import type { ReceiptLog } from './nft-mint-event-decoder.js';

export interface MinedReceipt { status: 'success' | 'reverted'; blockNumber: bigint; logs: ReceiptLog[]; }
export interface ReceiptProvider { getReceipt(transactionHash: string): Promise<MinedReceipt>; }

export class ViemReceiptProvider implements ReceiptProvider {
  constructor(private readonly client: PublicClient) {}
  async getReceipt(transactionHash: string): Promise<MinedReceipt> {
    const receipt = await this.client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    return { status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data, logIndex: Number(log.logIndex) })) };
  }
}
