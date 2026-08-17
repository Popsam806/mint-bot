DROP TABLE IF EXISTS execution_requests;
ALTER TABLE copy_transaction_proposals DROP COLUMN IF EXISTS expires_at;
ALTER TABLE copy_transaction_proposals DROP COLUMN IF EXISTS execution_status;
ALTER TABLE copy_transaction_proposals DROP COLUMN IF EXISTS user_id;
