import type { Pool } from 'pg';
import type { ExecutionAttempt, ExecutionAttemptStatus } from '../types.js';

const allowedTransitions: Record<ExecutionAttemptStatus, readonly ExecutionAttemptStatus[]> = {
  PENDING: ['CLAIMED', 'FAILED'], CLAIMED: ['SIMULATING', 'FAILED', 'RETRY', 'SKIPPED'],
  SIMULATING: ['SIGNING', 'FAILED', 'RETRY', 'SKIPPED'], SIGNING: ['SIGNED', 'UNKNOWN'],
  SIGNED: ['BROADCASTING', 'UNKNOWN'], BROADCASTING: ['SUBMITTED', 'FAILED', 'UNKNOWN'],
  SUBMITTED: ['CONFIRMED', 'REVERTED', 'UNKNOWN'], CONFIRMED: [], REVERTED: [], FAILED: [], SKIPPED: [],
  RETRY: ['CLAIMED', 'FAILED'], UNKNOWN: ['SUBMITTED', 'CONFIRMED', 'REVERTED'],
};

const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const map = (row: Record<string, unknown>): ExecutionAttempt => ({
  id: String(row.id), proposalId: String(row.proposal_id), sourceTransactionHash: String(row.source_transaction_hash),
  destinationWallet: String(row.destination_wallet), chainId: String(row.chain_id), status: row.status as ExecutionAttemptStatus,
  copyTransactionHash: nullable(row.copy_transaction_hash), nonce: nullable(row.nonce), gasEstimate: nullable(row.gas_estimate),
  nativeValue: nullable(row.native_value), failureReason: nullable(row.failure_reason), retryCount: Number(row.retry_count),
  executionStartedAt: row.execution_started_at as Date,
});

export class ExecutionAttemptRepository {
  constructor(private readonly db: Pool) {}
  async claim(input: { proposalId: string; sourceTransactionHash: string; destinationWallet: string; chainId: string; allowRetry?: boolean; pendingDetectedAt?: Date | null; analysisStartedAt?: Date | null; analysisCompletedAt?: Date | null }): Promise<ExecutionAttempt | null> {
    const identity = [input.chainId, input.sourceTransactionHash.toLowerCase(), input.destinationWallet.toLowerCase()];
    const existing = await this.db.query('SELECT * FROM execution_attempts WHERE chain_id=$1 AND source_transaction_hash=$2 AND destination_wallet=$3', identity);
    if (existing.rows[0]) {
      if (!input.allowRetry || existing.rows[0].status !== 'RETRY') return null;
      const reclaimed = await this.db.query("UPDATE execution_attempts SET status='CLAIMED', failure_reason=NULL, execution_started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='RETRY' RETURNING *", [existing.rows[0].id]);
      return reclaimed.rows[0] ? map(reclaimed.rows[0]) : null;
    }
    const result = await this.db.query(`INSERT INTO execution_attempts
      (proposal_id,source_transaction_hash,destination_wallet,chain_id,status,pending_detected_at,analysis_started_at,analysis_completed_at)
      VALUES ($1,$2,$3,$4,'CLAIMED',$5,$6,$7)
      ON CONFLICT (chain_id,source_transaction_hash,destination_wallet) DO NOTHING RETURNING *`,
    [input.proposalId, input.sourceTransactionHash.toLowerCase(), input.destinationWallet.toLowerCase(), input.chainId, input.pendingDetectedAt ?? null, input.analysisStartedAt ?? null, input.analysisCompletedAt ?? null]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async transition(id: string, status: ExecutionAttemptStatus, fields: { unsignedTransaction?: Record<string, string>; copyTransactionHash?: string; nonce?: bigint; gasEstimate?: bigint; nativeValue?: bigint; failureReason?: string; retry?: boolean } = {}): Promise<ExecutionAttempt> {
    const values: unknown[] = [id, status]; const assignments = ['status=$2', 'updated_at=CURRENT_TIMESTAMP'];
    const add = (column: string, value: unknown, cast = '') => { values.push(value); assignments.push(`${column}=$${values.length}${cast}`); };
    if (fields.unsignedTransaction) add('unsigned_transaction', JSON.stringify(fields.unsignedTransaction), '::jsonb');
    if (fields.copyTransactionHash) add('copy_transaction_hash', fields.copyTransactionHash.toLowerCase());
    if (fields.nonce !== undefined) add('nonce', fields.nonce.toString());
    if (fields.gasEstimate !== undefined) add('gas_estimate', fields.gasEstimate.toString());
    if (fields.nativeValue !== undefined) add('native_value', fields.nativeValue.toString());
    if (fields.failureReason !== undefined) add('failure_reason', fields.failureReason);
    if (fields.retry) assignments.push('retry_count=retry_count+1');
    if (status === 'SIMULATING') assignments.push('simulation_started_at=CURRENT_TIMESTAMP');
    if (['SIGNING','SKIPPED','FAILED','RETRY'].includes(status)) assignments.push('simulation_completed_at=CURRENT_TIMESTAMP');
    if (status === 'SIGNING') assignments.push('signing_started_at=CURRENT_TIMESTAMP');
    if (status === 'SIGNED') assignments.push('signed_at=CURRENT_TIMESTAMP');
    if (status === 'BROADCASTING') assignments.push('broadcast_started_at=CURRENT_TIMESTAMP');
    if (status === 'SUBMITTED') assignments.push('broadcast_completed_at=CURRENT_TIMESTAMP');
    if (['FAILED','REVERTED'].includes(status)) assignments.push('failed_at=CURRENT_TIMESTAMP');
    const fromStates = Object.entries(allowedTransitions).filter(([, targets]) => targets.includes(status)).map(([from]) => from);
    values.push(fromStates);
    const result = await this.db.query(`UPDATE execution_attempts SET ${assignments.join(', ')} WHERE id=$1 AND status = ANY($${values.length}::text[]) RETURNING *`, values);
    if (!result.rows[0]) throw new Error(`Invalid or concurrent execution-attempt transition to ${status}`);
    const proposalStatus = status === 'SUBMITTED' ? 'SUBMITTED' : status === 'CONFIRMED' ? 'CONFIRMED' : ['REVERTED', 'FAILED', 'SKIPPED'].includes(status) ? 'FAILED' : null;
    if (proposalStatus) await this.db.query(`UPDATE copy_transaction_proposals SET execution_status=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1
      AND execution_status NOT IN ('CONFIRMED','REJECTED','EXPIRED')`, [result.rows[0].proposal_id, proposalStatus]);
    return map(result.rows[0]);
  }
  async reconcile(hash: string, input: { confirmed: boolean; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint }): Promise<void> {
    await this.db.query(`UPDATE execution_attempts SET status=$2, block_number=$3, gas_used=$4, effective_gas_price=$5,
      confirmed_at=CURRENT_TIMESTAMP, failed_at=CASE WHEN $2='REVERTED' THEN CURRENT_TIMESTAMP ELSE failed_at END, updated_at=CURRENT_TIMESTAMP
      WHERE copy_transaction_hash=$1 AND status IN ('SUBMITTED','PENDING','BROADCASTING','UNKNOWN')`, [hash.toLowerCase(), input.confirmed ? 'CONFIRMED' : 'REVERTED', input.blockNumber.toString(), input.gasUsed.toString(), input.effectiveGasPrice.toString()]);
    await this.db.query(`UPDATE copy_transaction_proposals SET execution_status=$2, updated_at=CURRENT_TIMESTAMP
      WHERE id IN (SELECT proposal_id FROM execution_attempts WHERE copy_transaction_hash=$1) AND execution_status NOT IN ('REJECTED','EXPIRED')`,
    [hash.toLowerCase(), input.confirmed ? 'CONFIRMED' : 'FAILED']);
  }
  async listAwaitingConfirmation(): Promise<Array<{ transactionHash: string; externalChainId: number }>> {
    const result = await this.db.query(`SELECT ea.copy_transaction_hash, c.chain_id FROM execution_attempts ea
      JOIN chains c ON c.id=ea.chain_id WHERE ea.status IN ('SUBMITTED','PENDING') AND ea.copy_transaction_hash IS NOT NULL`);
    return result.rows.map((row) => ({ transactionHash: String(row.copy_transaction_hash), externalChainId: Number(row.chain_id) }));
  }
  async listRecoveryCandidates(): Promise<Array<ExecutionAttempt & { externalChainId: number }>> {
    const result = await this.db.query(`SELECT ea.*, c.chain_id AS external_chain_id FROM execution_attempts ea
      JOIN chains c ON c.id=ea.chain_id WHERE ea.status IN ('CLAIMED','SIMULATING','SIGNING','SIGNED','BROADCASTING','UNKNOWN','RETRY') ORDER BY ea.updated_at, ea.id`);
    return result.rows.map((row) => ({ ...map(row), externalChainId: Number(row.external_chain_id) }));
  }
  async findById(id: string): Promise<(ExecutionAttempt & { externalChainId: number }) | null> {
    const result = await this.db.query(`SELECT ea.*, c.chain_id AS external_chain_id FROM execution_attempts ea JOIN chains c ON c.id=ea.chain_id WHERE ea.id=$1`, [id]);
    return result.rows[0] ? { ...map(result.rows[0]), externalChainId: Number(result.rows[0].external_chain_id) } : null;
  }
  async listWorkItems(): Promise<Array<ExecutionAttempt & { externalChainId: number }>> {
    const result = await this.db.query(`SELECT ea.*, c.chain_id AS external_chain_id FROM execution_attempts ea JOIN chains c ON c.id=ea.chain_id
      WHERE ea.status IN ('RETRY','SIGNING','SIGNED','BROADCASTING','UNKNOWN','SUBMITTED') ORDER BY ea.updated_at, ea.id`);
    return result.rows.map((row) => ({ ...map(row), externalChainId: Number(row.external_chain_id) }));
  }
}
