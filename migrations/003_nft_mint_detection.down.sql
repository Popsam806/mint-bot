ALTER TABLE detected_transactions DROP COLUMN IF EXISTS analyzed_at;
ALTER TABLE detected_transactions DROP COLUMN IF EXISTS analysis_status;
DROP TABLE IF EXISTS detected_mints;
ALTER TABLE detected_mints_legacy RENAME TO detected_mints;
