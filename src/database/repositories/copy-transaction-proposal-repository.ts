import type { Pool } from 'pg';
import type { CopyTransactionProposal } from '../types.js';

type Input = Omit<CopyTransactionProposal, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'executionStatus'> & { userId?: string | null; expiresAt?: Date | null };
const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const map = (row: Record<string, unknown>): CopyTransactionProposal => ({ id: String(row.id), userId: nullable(row.user_id), detectedMintId: nullable(row.detected_mint_id), detectedTransactionId: nullable(row.detected_transaction_id), mintQuantity: String(row.mint_quantity ?? 1), sourceTransactionHash: String(row.source_transaction_hash), destinationWallet: String(row.destination_wallet), chainId: String(row.chain_id), strategy: row.strategy as CopyTransactionProposal['strategy'], eligibilityStatus: row.eligibility_status as CopyTransactionProposal['eligibilityStatus'], targetContract: nullable(row.target_contract), calldata: nullable(row.calldata), nativeValue: nullable(row.native_value), gasLimit: nullable(row.gas_limit), simulationStatus: row.simulation_status as CopyTransactionProposal['simulationStatus'], simulationError: nullable(row.simulation_error), proposalStatus: row.proposal_status as CopyTransactionProposal['proposalStatus'], confidence: row.confidence as CopyTransactionProposal['confidence'], executionStatus: row.execution_status as CopyTransactionProposal['executionStatus'], expiresAt: row.expires_at as Date | null, explanation: String(row.explanation), createdAt: row.created_at as Date, updatedAt: row.updated_at as Date });

export class CopyTransactionProposalRepository {
  constructor(private readonly db: Pool) {}
  async createIfAbsent(input: Input): Promise<CopyTransactionProposal> {
    const existing = await this.db.query('SELECT * FROM copy_transaction_proposals WHERE chain_id = $1 AND source_transaction_hash = $2 AND destination_wallet = $3', [input.chainId, input.sourceTransactionHash.toLowerCase(), input.destinationWallet.toLowerCase()]);
    if (existing.rows[0]) return map(existing.rows[0]);
    const result = await this.db.query(`INSERT INTO copy_transaction_proposals
      (detected_mint_id, detected_transaction_id, mint_quantity, user_id, source_transaction_hash, destination_wallet, chain_id, strategy, eligibility_status, target_contract, calldata, native_value, gas_limit, simulation_status, simulation_error, proposal_status, confidence, execution_status, expires_at, explanation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, CASE WHEN $16 = 'READY' THEN 'READY' ELSE 'PENDING' END, $18, $19)
      ON CONFLICT (chain_id, source_transaction_hash, destination_wallet) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING *`, [input.detectedMintId, input.detectedTransactionId ?? null, input.mintQuantity ?? '1', input.userId ?? null, input.sourceTransactionHash.toLowerCase(), input.destinationWallet.toLowerCase(), input.chainId, input.strategy, input.eligibilityStatus, input.targetContract?.toLowerCase() ?? null, input.calldata, input.nativeValue, input.gasLimit, input.simulationStatus, input.simulationError, input.proposalStatus, input.confidence, input.expiresAt ?? null, input.explanation]);
    return map(result.rows[0]);
  }
  async findById(id: string): Promise<CopyTransactionProposal | null> {
    const result = await this.db.query('SELECT * FROM copy_transaction_proposals WHERE id = $1', [id]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async changeExecutionStatus(id: string, expected: CopyTransactionProposal['executionStatus'], next: CopyTransactionProposal['executionStatus']): Promise<CopyTransactionProposal | null> {
    const result = await this.db.query('UPDATE copy_transaction_proposals SET execution_status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND execution_status = $2 RETURNING *', [id, expected, next]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async getNotificationDetails(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query(`SELECT p.*, u.telegram_user_id, c.name AS chain_name, m.nft_contract_address, m.quantity
      FROM copy_transaction_proposals p JOIN users u ON u.id = p.user_id JOIN chains c ON c.id = p.chain_id
      JOIN detected_mints m ON m.id = p.detected_mint_id WHERE p.id = $1`, [id]);
    return result.rows[0] ?? null;
  }
}
