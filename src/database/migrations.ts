import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

const migrationsDirectory = resolve('migrations');

export async function migrateUp(db: Pool): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)');
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.up.sql')).sort();
  for (const file of files) {
    const applied = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rowCount) continue;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(migrationsDirectory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, CURRENT_TIMESTAMP)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

export async function migrateDown(db: Pool): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)');
  const result = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
  const migration = result.rows[0];
  if (!migration) return;
  const downFile = migration.name.replace(/\.up\.sql$/, '.down.sql');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(await readFile(resolve(migrationsDirectory, downFile), 'utf8'));
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [migration.name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
