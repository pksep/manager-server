ALTER TABLE customers ADD COLUMN erp_contact_updated_at timestamptz;
DROP INDEX erp_sync_active_customer;
CREATE UNIQUE INDEX erp_sync_active_customer ON erp_sync_operations(customer_id) WHERE state IN ('pending','working');
