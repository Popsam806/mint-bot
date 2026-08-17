import { env } from '../config/env.js';
import { createPostgresPool } from './postgres.js';
import { migrateDown, migrateUp } from './migrations.js';

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') throw new Error('Usage: migrate.ts <up|down>');
  const db = createPostgresPool(env.DATABASE_URL);
  try { await (direction === 'up' ? migrateUp(db) : migrateDown(db)); }
  finally { await db.end(); }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
