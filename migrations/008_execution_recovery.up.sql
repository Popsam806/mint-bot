ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_status_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_status_check
  CHECK (status IN ('PENDING','CLAIMED','SIMULATING','SIGNING','SIGNED','BROADCASTING','SUBMITTED','CONFIRMED','REVERTED','FAILED','SKIPPED','RETRY','UNKNOWN'));
