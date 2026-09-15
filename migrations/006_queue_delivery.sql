ALTER TABLE delivery_operations ADD COLUMN queued_until timestamptz;
ALTER TABLE erp_sync_operations ADD COLUMN queued_until timestamptz;
CREATE INDEX delivery_outbox ON delivery_operations(queued_until) WHERE state IN ('pending','working');
CREATE INDEX erp_outbox ON erp_sync_operations(queued_until) WHERE state IN ('pending','working');
