import type { Pool } from 'pg';
import type { MonitoredAddress } from '../types.js';
import { mapMonitoredAddress } from './mappers.js';

export class MonitoredAddressRepository {
  constructor(private readonly db: Pool) {}
  async create(input: { userId: string; chainId: string; walletAddress: string; enabled?: boolean }): Promise<MonitoredAddress> {
    const result = await this.db.query('INSERT INTO monitored_addresses (user_id, chain_id, wallet_address, enabled) VALUES ($1, $2, $3, $4) RETURNING *', [input.userId, input.chainId, input.walletAddress.toLowerCase(), input.enabled ?? true]);
    return mapMonitoredAddress(result.rows[0]);
  }
  async findById(id: string): Promise<MonitoredAddress | null> {
    const result = await this.db.query('SELECT * FROM monitored_addresses WHERE id = $1', [id]);
    return result.rows[0] ? mapMonitoredAddress(result.rows[0]) : null;
  }
  async findByUserAndWallet(userId: string, walletAddress: string): Promise<MonitoredAddress | null> {
    const result = await this.db.query('SELECT * FROM monitored_addresses WHERE user_id = $1 AND wallet_address = $2', [userId, walletAddress.toLowerCase()]);
    return result.rows[0] ? mapMonitoredAddress(result.rows[0]) : null;
  }
  async listByUser(userId: string): Promise<MonitoredAddress[]> {
    const result = await this.db.query('SELECT * FROM monitored_addresses WHERE user_id = $1 ORDER BY id', [userId]);
    return result.rows.map(mapMonitoredAddress);
  }
  async listByUserWithChain(userId: string): Promise<Array<MonitoredAddress & { chainName: string }>> {
    const result = await this.db.query(`SELECT monitored_addresses.*, chains.name AS chain_name
      FROM monitored_addresses JOIN chains ON chains.id = monitored_addresses.chain_id
      WHERE monitored_addresses.user_id = $1 ORDER BY monitored_addresses.id`, [userId]);
    return result.rows.map((row) => ({ ...mapMonitoredAddress(row), chainName: String(row.chain_name) }));
  }
  async listEnabledByChain(): Promise<Array<MonitoredAddress & { chainName: string; externalChainId: string }>> {
    const result = await this.db.query(`SELECT monitored_addresses.*, chains.name AS chain_name, chains.chain_id AS external_chain_id
      FROM monitored_addresses JOIN chains ON chains.id = monitored_addresses.chain_id
      WHERE monitored_addresses.enabled = TRUE AND chains.enabled = TRUE ORDER BY monitored_addresses.chain_id, monitored_addresses.id`);
    return result.rows.map((row) => ({ ...mapMonitoredAddress(row), chainName: String(row.chain_name), externalChainId: String(row.external_chain_id) }));
  }
  async setEnabled(id: string, enabled: boolean): Promise<MonitoredAddress | null> {
    const result = await this.db.query('UPDATE monitored_addresses SET enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *', [id, enabled]);
    return result.rows[0] ? mapMonitoredAddress(result.rows[0]) : null;
  }
}
