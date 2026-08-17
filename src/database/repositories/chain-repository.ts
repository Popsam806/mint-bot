import type { Pool } from 'pg';
import type { ChainRecord } from '../types.js';
import { mapChain } from './mappers.js';

export class ChainRepository {
  constructor(private readonly db: Pool) {}
  async findOrCreate(chainId: string, name: string, enabled = true): Promise<ChainRecord> {
    const result = await this.db.query(`INSERT INTO chains (chain_id, name, enabled) VALUES ($1, $2, $3)
      ON CONFLICT (chain_id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP RETURNING *`, [chainId, name, enabled]);
    return mapChain(result.rows[0]);
  }
  async create(chainId: string, name: string, enabled = true): Promise<ChainRecord> {
    const result = await this.db.query('INSERT INTO chains (chain_id, name, enabled) VALUES ($1, $2, $3) RETURNING *', [chainId, name, enabled]);
    return mapChain(result.rows[0]);
  }
  async findByChainId(chainId: string): Promise<ChainRecord | null> {
    const result = await this.db.query('SELECT * FROM chains WHERE chain_id = $1', [chainId]);
    return result.rows[0] ? mapChain(result.rows[0]) : null;
  }
  async findById(id: string): Promise<ChainRecord | null> {
    const result = await this.db.query('SELECT * FROM chains WHERE id = $1', [id]);
    return result.rows[0] ? mapChain(result.rows[0]) : null;
  }
  async setEnabled(id: string, enabled: boolean): Promise<ChainRecord | null> {
    const result = await this.db.query('UPDATE chains SET enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *', [id, enabled]);
    return result.rows[0] ? mapChain(result.rows[0]) : null;
  }
}
