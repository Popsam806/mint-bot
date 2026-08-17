import { isAddress } from 'viem';
import type { DetectedMint, CopyTransactionProposal } from '../database/types.js';
import type { TransactionAnalysisProvider } from '../blockchain/clients/transaction-analysis-provider.js';
import { analyzeMintCalldata } from '../blockchain/decoders/mint-calldata-strategies.js';
import type { CopyTransactionBuilder } from './copy-transaction-builder.js';

export class MintTransactionAnalyzer {
  constructor(private readonly builder: CopyTransactionBuilder) {}
  async analyze(mint: DetectedMint, destinationWallet: string, provider: TransactionAnalysisProvider, userId: string): Promise<CopyTransactionProposal> {
    if (!isAddress(destinationWallet)) throw new Error('Invalid destination wallet');
    const source = await provider.getTransaction(mint.transactionHash);
    const strategy = analyzeMintCalldata(source.input, mint.recipientAddress, destinationWallet);
    return this.builder.build(mint, destinationWallet.toLowerCase(), userId, source, strategy, provider);
  }
}
