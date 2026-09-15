ALTER TABLE erp_sync_operations ADD COLUMN request jsonb;
ALTER TABLE erp_sync_operations ADD COLUMN fingerprint text;
ALTER TABLE erp_sync_operations ADD COLUMN erp_actor_id integer;
ALTER TABLE erp_sync_operations ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE erp_sync_operations ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE erp_sync_operations ADD COLUMN locked_until timestamptz;
ALTER TABLE erp_sync_operations ADD CONSTRAINT erp_sync_state CHECK(state IN ('pending','working','completed','failed','conflict'));
CREATE INDEX erp_sync_pending ON erp_sync_operations(next_attempt_at) WHERE state IN ('pending','working');
