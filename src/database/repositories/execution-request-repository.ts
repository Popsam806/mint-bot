import type { Pool } from 'pg';
import type { ExecutionRequest } from '../types.js';

const map = (row: Record<string, unknown>): ExecutionRequest => ({ id: String(row.id), proposalId: String(row.proposal_id), userId: String(row.user_id), status: row.status as ExecutionRequest['status'], createdAt: row.created_at as Date, updatedAt: row.updated_at as Date });

export class ExecutionRequestRepository {
  constructor(private readonly db: Pool) {}
  async createIfAbsent(proposalId: string, userId: string): Promise<ExecutionRequest> {
    const result = await this.db.query(`INSERT INTO execution_requests (proposal_id, user_id) VALUES ($1, $2)
      ON CONFLICT (proposal_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING *`, [proposalId, userId]);
    return map(result.rows[0]);
  }
}
