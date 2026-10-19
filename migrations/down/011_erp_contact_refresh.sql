-- Старый сервер допускает лишь одну завершённую операцию клиента.
-- При повторных синхронизациях откат блокируется, журнал не удаляется.
DO $$ BEGIN
  IF EXISTS(SELECT customer_id FROM erp_sync_operations WHERE state IN ('pending','working','completed') GROUP BY customer_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Нельзя откатить обновление контактов с повторными синхронизациями';
  END IF;
END $$;
DROP INDEX erp_sync_active_customer;
CREATE UNIQUE INDEX erp_sync_active_customer ON erp_sync_operations(customer_id) WHERE state IN ('pending','working','completed');
ALTER TABLE customers DROP COLUMN erp_contact_updated_at;
