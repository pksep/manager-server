DROP INDEX IF EXISTS delivery_outbox, erp_outbox;
ALTER TABLE delivery_operations DROP COLUMN IF EXISTS queued_until;
ALTER TABLE erp_sync_operations DROP COLUMN IF EXISTS queued_until;
