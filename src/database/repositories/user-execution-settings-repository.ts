import type { Pool } from 'pg';
import type { ExecutionMode, UserExecutionSettings } from '../types.js';

const map = (row: Record<string, unknown>): UserExecutionSettings => ({
  userId: String(row.user_id), executionMode: row.execution_mode as ExecutionMode,
  destinationWallet: row.destination_wallet === null ? null : String(row.destination_wallet),
  allowedChains: (row.allowed_chains as string[] | null) ?? [],
  allowedContracts: (row.allowed_contracts as string[] | null) ?? [],
  maxNativeValue: row.max_native_value === null ? null : String(row.max_native_value),
  maxGas: row.max_gas === null ? null : String(row.max_gas),
  maxQuantity: row.max_quantity === null ? null : String(row.max_quantity),
  proposalExpirationSeconds: Number(row.proposal_expiration_seconds),
  autoRetryEnabled: Boolean(row.auto_retry_enabled), createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
});

export type ExecutionSettingsUpdate = Partial<Omit<UserExecutionSettings, 'userId' | 'createdAt' | 'updatedAt'>>;

export class UserExecutionSettingsRepository {
  constructor(private readonly db: Pool) {}
  async getOrCreate(userId: string): Promise<UserExecutionSettings> {
    const result = await this.db.query(`INSERT INTO user_execution_settings (user_id) VALUES ($1)
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING *`, [userId]);
    return map(result.rows[0]);
  }
  async update(userId: string, input: ExecutionSettingsUpdate): Promise<UserExecutionSettings> {
    await this.getOrCreate(userId);
    const current = await this.getOrCreate(userId);
    const next = { ...current, ...input };
    const result = await this.db.query(`UPDATE user_execution_settings SET execution_mode=$2, destination_wallet=$3,
      allowed_chains=$4::jsonb, allowed_contracts=$5::jsonb, max_native_value=$6, max_gas=$7, max_quantity=$8,
      proposal_expiration_seconds=$9, auto_retry_enabled=$10, updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 RETURNING *`,
    [userId, next.executionMode, next.destinationWallet?.toLowerCase() ?? null, JSON.stringify(next.allowedChains), JSON.stringify(next.allowedContracts.map((value) => value.toLowerCase())), next.maxNativeValue, next.maxGas, next.maxQuantity, next.proposalExpirationSeconds, next.autoRetryEnabled]);
    return map(result.rows[0]);
  }
}
