import type { Pool } from 'pg';
import type { DetectedTransaction } from '../types.js';
import type { PendingSourceTransaction, PendingObservation } from '../../blockchain/listeners/pending-transaction-provider.js';

type Row = Record<string, unknown>;
const textOrNull = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const map = (row: Row): DetectedTransaction => ({
  id: String(row.id), monitoredAddressId: String(row.monitored_address_id), chainId: String(row.chain_id),
  transactionHash: String(row.transaction_hash), blockNumber: String(row.block_number), fromAddress: String(row.from_address),
  toAddress: textOrNull(row.to_address), transactionValue: String(row.transaction_value), inputData: String(row.input_data),
  gasLimit: textOrNull(row.gas_limit), gasPrice: textOrNull(row.gas_price), effectiveGasPrice: textOrNull(row.effective_gas_price),
  detectedAt: row.detected_at as Date, status: row.status as DetectedTransaction['status'],
  analysisStatus: row.analysis_status as DetectedTransaction['analysisStatus'], analyzedAt: row.analyzed_at as Date | null,
  nonce: textOrNull(row.nonce), originalTransactionHash: String(row.original_transaction_hash ?? row.transaction_hash), replacementTransactionId: textOrNull(row.replacement_transaction_id),
  firstSeenAt: row.first_seen_at as Date ?? row.detected_at as Date, lastSeenAt: row.last_seen_at as Date ?? row.detected_at as Date,
  observedAt: row.observed_at as Date ?? row.detected_at as Date, ingestedAt: row.ingested_at as Date ?? row.detected_at as Date,
  analysisStartedAt: row.analysis_started_at as Date | null, analysisCompletedAt: row.analysis_completed_at as Date | null,
  minedBlockNumber: textOrNull(row.mined_block_number ?? row.block_number), providerObservation: textOrNull(row.provider_observation),
});

export interface PersistDetectedTransaction {
  monitoredAddressId: string; chainId: string; transactionHash: string; blockNumber: string;
  fromAddress: string; toAddress: string | null; transactionValue: string; inputData: string;
  gasLimit: string | null; gasPrice: string | null; effectiveGasPrice: string | null;
}

export class DetectedTransactionRepository {
  constructor(private readonly db: Pool) {}
  async createIfAbsent(input: PersistDetectedTransaction): Promise<DetectedTransaction | null> {
    const existing = await this.db.query('SELECT 1 FROM detected_transactions WHERE monitored_address_id = $1 AND transaction_hash = $2', [input.monitoredAddressId, input.transactionHash.toLowerCase()]);
    if (existing.rowCount) return null;
    const result = await this.db.query(`INSERT INTO detected_transactions
      (monitored_address_id, chain_id, transaction_hash, block_number, from_address, to_address, transaction_value, input_data, gas_limit, gas_price, effective_gas_price)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (monitored_address_id, transaction_hash) DO NOTHING RETURNING *`, [input.monitoredAddressId, input.chainId, input.transactionHash.toLowerCase(), input.blockNumber, input.fromAddress.toLowerCase(), input.toAddress?.toLowerCase() ?? null, input.transactionValue, input.inputData, input.gasLimit, input.gasPrice, input.effectiveGasPrice]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async upsertPending(input: { monitoredAddressId: string; chainId: string; transaction: PendingSourceTransaction; observation: PendingObservation }): Promise<DetectedTransaction> {
    const existing = await this.db.query('SELECT * FROM detected_transactions WHERE monitored_address_id = $1 AND transaction_hash = $2', [input.monitoredAddressId, input.transaction.hash.toLowerCase()]);
    if (existing.rows[0]) {
      await this.db.query('UPDATE detected_transactions SET last_seen_at = $2, observed_at = $3, provider_observation = $4 WHERE id = $1', [existing.rows[0].id, new Date(), input.observation.observedAt, input.observation.provider]);
      const refreshed = await this.db.query('SELECT * FROM detected_transactions WHERE id = $1', [existing.rows[0].id]);
      return map(refreshed.rows[0]);
    }
    const previous = await this.db.query(`SELECT id, transaction_hash FROM detected_transactions WHERE chain_id = $1 AND from_address = $2 AND nonce = $3 AND status = 'PENDING' LIMIT 1`, [input.chainId, input.transaction.from.toLowerCase(), input.transaction.nonce.toString()]);
    const result = await this.db.query(`INSERT INTO detected_transactions
      (monitored_address_id, chain_id, transaction_hash, block_number, from_address, to_address, transaction_value, input_data, gas_limit, gas_price, effective_gas_price, status, nonce, original_transaction_hash, first_seen_at, last_seen_at, observed_at, ingested_at, provider_observation)
      VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,NULL,'PENDING',$10,$3,$11,$11,$12,CURRENT_TIMESTAMP,$13) RETURNING *`, [input.monitoredAddressId, input.chainId, input.transaction.hash.toLowerCase(), input.transaction.from.toLowerCase(), input.transaction.to?.toLowerCase() ?? null, input.transaction.value.toString(), input.transaction.input, input.transaction.gas?.toString() ?? null, input.transaction.gasPrice?.toString() ?? null, input.transaction.nonce.toString(), input.observation.observedAt, input.observation.observedAt, input.observation.provider]);
    const saved = map(result.rows[0]);
    if (previous.rows[0] && previous.rows[0].id !== saved.id) {
      await this.db.query("UPDATE detected_transactions SET status = 'REPLACED', replacement_transaction_id = $2, last_seen_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'PENDING'", [previous.rows[0].id, saved.id]);
      await this.invalidateExecutionsByHash(String(previous.rows[0].transaction_hash), 'Source transaction was replaced');
    }
    return saved;
  }
  async markMined(transactionHash: string, blockNumber: bigint, reverted = false): Promise<void> {
    await this.db.query("UPDATE detected_transactions SET status = $2, block_number = $3, mined_block_number = $3, last_seen_at = CURRENT_TIMESTAMP WHERE transaction_hash = $1 AND status IN ('PENDING','detected','MINED')", [transactionHash.toLowerCase(), reverted ? 'REVERTED' : 'MINED', blockNumber.toString()]);
    if (reverted) await this.invalidateExecutionsByHash(transactionHash, 'Source transaction reverted');
  }
  async markDroppedBefore(cutoff: Date): Promise<number> {
    const stale = await this.db.query("SELECT transaction_hash FROM detected_transactions WHERE status = 'PENDING' AND last_seen_at < $1", [cutoff]);
    const result = await this.db.query("UPDATE detected_transactions SET status = 'DROPPED', last_seen_at = CURRENT_TIMESTAMP WHERE status = 'PENDING' AND last_seen_at < $1", [cutoff]);
    for (const row of stale.rows) await this.invalidateExecutionsByHash(String(row.transaction_hash), 'Source transaction dropped');
    return result.rowCount ?? 0;
  }
  private async invalidateExecutionsByHash(hash: string, reason: string): Promise<void> {
    await this.db.query("UPDATE execution_attempts SET status='SKIPPED', failure_reason=$2, failed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE source_transaction_hash=$1 AND status IN ('CLAIMED','SIMULATING','RETRY')", [hash.toLowerCase(), reason]);
    await this.db.query(`UPDATE copy_transaction_proposals SET execution_status='FAILED', updated_at=CURRENT_TIMESTAMP
      WHERE id IN (SELECT proposal_id FROM execution_attempts WHERE source_transaction_hash=$1 AND status='SKIPPED')
      AND execution_status NOT IN ('SUBMITTED','CONFIRMED')`, [hash.toLowerCase()]);
  }
  async markAnalysisTiming(id: string, startedAt: Date, completedAt: Date): Promise<void> {
    await this.db.query('UPDATE detected_transactions SET analysis_started_at = $2, analysis_completed_at = $3 WHERE id = $1', [id, startedAt, completedAt]);
  }
  async markInvalidated(transactionHash: string, reason = 'Source transaction invalidated'): Promise<void> {
    await this.db.query("UPDATE detected_transactions SET status='INVALIDATED', last_seen_at=CURRENT_TIMESTAMP WHERE transaction_hash=$1 AND status='PENDING'", [transactionHash.toLowerCase()]);
    await this.invalidateExecutionsByHash(transactionHash, reason);
  }
  async listMinedForReconciliation(limit = 500): Promise<Array<{ transactionHash: string; externalChainId: number }>> {
    const result = await this.db.query(`SELECT dt.transaction_hash, c.chain_id FROM detected_transactions dt JOIN chains c ON c.id=dt.chain_id
      WHERE dt.status='MINED' ORDER BY dt.last_seen_at DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ transactionHash: String(row.transaction_hash), externalChainId: Number(row.chain_id) }));
  }
  async markReorged(transactionHash: string): Promise<void> {
    const hash = transactionHash.toLowerCase();
    await this.db.query("UPDATE detected_transactions SET status='reorged', last_seen_at=CURRENT_TIMESTAMP WHERE transaction_hash=$1 AND status='MINED'", [hash]);
    await this.invalidateExecutionsByHash(hash, 'Source transaction was removed by a chain reorganization');
  }
  async setAnalysisStatus(id: string, status: DetectedTransaction['analysisStatus']): Promise<void> {
    await this.db.query('UPDATE detected_transactions SET analysis_status = $2, analyzed_at = CASE WHEN $2 IN (\'analyzed\', \'failed\') THEN CURRENT_TIMESTAMP ELSE analyzed_at END WHERE id = $1', [id, status]);
  }
}
