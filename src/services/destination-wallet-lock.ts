import type { Pool, PoolClient } from 'pg';

export interface DestinationWalletLock { withLock<T>(chainId: number, wallet: string, operation: () => Promise<T>): Promise<T>; }
export class LocalDestinationWalletLock implements DestinationWalletLock {
  withLock<T>(_chainId: number, _wallet: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}
export class PostgresDestinationWalletLock implements DestinationWalletLock {
  constructor(private readonly db: Pool) {}
  async withLock<T>(chainId: number, wallet: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    const key = `${chainId}:${wallet.toLowerCase()}`;
    let acquired = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [key]);
      acquired = Boolean(result.rows[0]?.acquired);
      if (!acquired) throw new Error('Destination wallet is busy; execution must be retried');
      return await operation();
    } finally { if (acquired) await this.unlock(client, key); client.release(); }
  }
  private async unlock(client: PoolClient, key: string): Promise<void> {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); } catch { /* Connection teardown releases session locks. */ }
  }
}
