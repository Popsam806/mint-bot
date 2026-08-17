UPDATE execution_attempts SET status='FAILED', failure_reason=COALESCE(failure_reason, 'Recovery state removed by migration rollback')
WHERE status IN ('BROADCASTING','UNKNOWN');
ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_status_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_status_check
  CHECK (status IN ('CLAIMED','SIMULATING','SIGNING','SIGNED','SUBMITTED','PENDING','CONFIRMED','REVERTED','FAILED','SKIPPED','RETRY'));
