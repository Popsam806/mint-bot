DROP TABLE IF EXISTS execution_attempts;
DROP TABLE IF EXISTS user_execution_settings;
DELETE FROM copy_transaction_proposals WHERE detected_mint_id IS NULL;
ALTER TABLE copy_transaction_proposals DROP CONSTRAINT IF EXISTS copy_proposal_source_check;
ALTER TABLE copy_transaction_proposals DROP COLUMN IF EXISTS mint_quantity;
ALTER TABLE copy_transaction_proposals DROP COLUMN IF EXISTS detected_transaction_id;
ALTER TABLE copy_transaction_proposals ALTER COLUMN detected_mint_id SET NOT NULL;
