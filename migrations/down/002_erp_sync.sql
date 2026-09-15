DROP INDEX IF EXISTS erp_sync_pending;
ALTER TABLE erp_sync_operations DROP CONSTRAINT IF EXISTS erp_sync_state;
ALTER TABLE erp_sync_operations DROP COLUMN IF EXISTS request, DROP COLUMN IF EXISTS fingerprint, DROP COLUMN IF EXISTS erp_actor_id, DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS locked_until;
