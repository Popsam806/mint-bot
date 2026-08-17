import type { Pool } from 'pg';

export class MonitoringCheckpointRepository {
  constructor(private readonly db: Pool) {}
  async get(chainId: string): Promise<bigint | null> {
    const result = await this.db.query('SELECT last_processed_block FROM monitoring_checkpoints WHERE chain_id = $1', [chainId]);
    return result.rows[0] ? BigInt(result.rows[0].last_processed_block) : null;
  }
  async save(chainId: string, block: bigint): Promise<void> {
    await this.db.query(`INSERT INTO monitoring_checkpoints (chain_id, last_processed_block) VALUES ($1, $2)
      ON CONFLICT (chain_id) DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block, updated_at = CURRENT_TIMESTAMP`, [chainId, block.toString()]);
  }
}
