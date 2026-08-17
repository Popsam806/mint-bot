import type { Logger } from 'pino';
import type { DetectedTransaction, MonitoredAddress } from '../database/types.js';
import type { DetectedMintRepository } from '../database/repositories/detected-mint-repository.js';
import type { DetectedTransactionRepository } from '../database/repositories/detected-transaction-repository.js';
import type { ReceiptProvider } from '../blockchain/decoders/receipt-provider.js';
import { decodeNftMintEvents } from '../blockchain/decoders/nft-mint-event-decoder.js';

export class NftMintDetector {
  constructor(private readonly transactions: DetectedTransactionRepository, private readonly mints: DetectedMintRepository, private readonly logger: Logger) {}
  async analyze(transaction: DetectedTransaction, monitored: MonitoredAddress, provider: ReceiptProvider): Promise<number> {
    if (transaction.analysisStatus === 'analyzed') return 0;
    await this.transactions.setAnalysisStatus(transaction.id, 'analyzing');
    try {
      const receipt = await provider.getReceipt(transaction.transactionHash);
      if (receipt.status === 'reverted') { await this.transactions.setAnalysisStatus(transaction.id, 'analyzed'); return 0; }
      const events = decodeNftMintEvents(receipt.logs, monitored.walletAddress);
      let created = 0;
      for (const event of events) {
        const mint = await this.mints.createIfAbsent({ detectedTransactionId: transaction.id, monitoredAddressId: monitored.id, chainId: transaction.chainId, transactionHash: transaction.transactionHash, nftStandard: event.standard, nftContractAddress: event.contractAddress, tokenId: event.tokenId.toString(), quantity: event.quantity.toString(), recipientAddress: event.recipient, blockNumber: receipt.blockNumber.toString(), logIndex: event.logIndex, batchIndex: event.batchIndex });
        if (mint) created += 1;
      }
      await this.transactions.setAnalysisStatus(transaction.id, 'analyzed');
      this.logger.info({ transactionHash: transaction.transactionHash, mintCount: created }, 'NFT mint analysis complete');
      return created;
    } catch (error) {
      await this.transactions.setAnalysisStatus(transaction.id, 'failed');
      this.logger.error({ transactionHash: transaction.transactionHash, error }, 'NFT mint analysis failed');
      throw error;
    }
  }
}
