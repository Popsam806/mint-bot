import type { Pool } from 'pg';
import type { DetectedMint, DetectedMintStatus } from '../types.js';
import { mapDetectedMint } from './mappers.js';

export interface CreateDetectedMint {
  detectedTransactionId: string; monitoredAddressId: string; chainId: string; transactionHash: string;
  nftStandard: 'ERC721' | 'ERC1155'; nftContractAddress: string; tokenId: string; quantity: string;
  recipientAddress: string; blockNumber: string; logIndex: number; batchIndex: number;
}

export class DetectedMintRepository {
  constructor(private readonly db: Pool) {}
  async createIfAbsent(input: CreateDetectedMint): Promise<DetectedMint | null> {
    const existing = await this.db.query('SELECT * FROM detected_mints WHERE detected_transaction_id = $1 AND log_index = $2 AND batch_index = $3', [input.detectedTransactionId, input.logIndex, input.batchIndex]);
    if (existing.rows[0]) return null;
    const result = await this.db.query(`INSERT INTO detected_mints
      (detected_transaction_id, monitored_address_id, chain_id, transaction_hash, nft_standard, nft_contract_address, token_id, quantity, recipient_address, block_number, log_index, batch_index)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (detected_transaction_id, log_index, batch_index) DO NOTHING RETURNING *`,
      [input.detectedTransactionId, input.monitoredAddressId, input.chainId, input.transactionHash.toLowerCase(), input.nftStandard, input.nftContractAddress.toLowerCase(), input.tokenId, input.quantity, input.recipientAddress.toLowerCase(), input.blockNumber, input.logIndex, input.batchIndex]);
    return result.rows[0] ? mapDetectedMint(result.rows[0]) : null;
  }
  async findById(id: string): Promise<DetectedMint | null> {
    const result = await this.db.query('SELECT * FROM detected_mints WHERE id = $1', [id]);
    return result.rows[0] ? mapDetectedMint(result.rows[0]) : null;
  }
  async setStatus(id: string, status: DetectedMintStatus): Promise<DetectedMint | null> {
    const result = await this.db.query('UPDATE detected_mints SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
    return result.rows[0] ? mapDetectedMint(result.rows[0]) : null;
  }
}
