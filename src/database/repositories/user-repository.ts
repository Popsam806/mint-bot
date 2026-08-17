import type { Pool } from 'pg';
import type { User } from '../types.js';
import { mapUser } from './mappers.js';

export class UserRepository {
  constructor(private readonly db: Pool) {}
  async findByTelegramUserId(telegramUserId: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }
  async findOrCreate(telegramUserId: string, username: string | null = null): Promise<User> {
    const result = await this.db.query(`INSERT INTO users (telegram_user_id, username) VALUES ($1, $2)
      ON CONFLICT (telegram_user_id) DO UPDATE SET username = EXCLUDED.username, updated_at = CURRENT_TIMESTAMP RETURNING *`, [telegramUserId, username]);
    return mapUser(result.rows[0]);
  }
  async create(telegramUserId: string, username: string | null = null): Promise<User> {
    const result = await this.db.query('INSERT INTO users (telegram_user_id, username) VALUES ($1, $2) RETURNING *', [telegramUserId, username]);
    return mapUser(result.rows[0]);
  }
  async findById(id: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }
  async updateUsername(id: string, username: string | null): Promise<User | null> {
    const result = await this.db.query('UPDATE users SET username = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *', [id, username]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }
  async delete(id: string): Promise<boolean> {
    return (await this.db.query('DELETE FROM users WHERE id = $1', [id])).rowCount === 1;
  }
}
