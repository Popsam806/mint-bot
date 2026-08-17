import type { Pool } from 'pg';

export interface AutomaticExecutionContext {
  monitoredSourceEnabled: boolean; chainEnabled: boolean; sourceStatus: string; sourceCurrent: boolean;
  quantity: bigint; contractAddress: string | null; pendingDetectedAt: Date | null;
  analysisStartedAt: Date | null; analysisCompletedAt: Date | null;
}

export class AutomaticExecutionContextRepository {
  constructor(private readonly db: Pool) {}
  async load(proposalId: string): Promise<AutomaticExecutionContext | null> {
    const result = await this.db.query(`SELECT ma.enabled AS monitored_source_enabled, c.enabled AS chain_enabled,
      dt.status AS source_status, dt.replacement_transaction_id, COALESCE(p.mint_quantity,dm.quantity,1) AS quantity, COALESCE(dm.nft_contract_address,p.target_contract) AS nft_contract_address,
      dt.observed_at, dt.analysis_started_at, dt.analysis_completed_at
      FROM copy_transaction_proposals p
      LEFT JOIN detected_mints dm ON dm.id=p.detected_mint_id
      JOIN detected_transactions dt ON dt.id=p.detected_transaction_id OR (p.detected_transaction_id IS NULL AND dt.id=dm.detected_transaction_id)
      JOIN monitored_addresses ma ON ma.id=dt.monitored_address_id
      JOIN chains c ON c.id=p.chain_id WHERE p.id=$1`, [proposalId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return { monitoredSourceEnabled: Boolean(row.monitored_source_enabled), chainEnabled: Boolean(row.chain_enabled),
      sourceStatus: String(row.source_status), sourceCurrent: row.replacement_transaction_id === null,
      quantity: BigInt(String(row.quantity)), contractAddress: row.nft_contract_address === null ? null : String(row.nft_contract_address),
      pendingDetectedAt: row.observed_at as Date | null, analysisStartedAt: row.analysis_started_at as Date | null,
      analysisCompletedAt: row.analysis_completed_at as Date | null };
  }
}
