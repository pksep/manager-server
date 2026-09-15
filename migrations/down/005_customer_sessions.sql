-- Старая схема не может представить объединённые сессии: откат обязан сохранить изоляцию истории.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM guest_sessions g JOIN inquiries i ON i.id=g.inquiry_id WHERE g.id<>i.session_id)
    OR EXISTS(SELECT 1 FROM customers WHERE merged_into IS NOT NULL)
    OR EXISTS(SELECT 1 FROM inquiries WHERE merged_into IS NOT NULL)
  THEN RAISE EXCEPTION 'Откат 005 требует восстановления резервной копии до объединения сессий'; END IF;
END $$;
DROP INDEX IF EXISTS inquiries_active_customer;
DROP INDEX IF EXISTS messages_session_history;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_session_operation;
ALTER TABLE messages ADD CONSTRAINT messages_inquiry_id_operation_id_key UNIQUE(inquiry_id,operation_id);
ALTER TABLE messages DROP COLUMN IF EXISTS session_id;
DROP INDEX IF EXISTS guest_sessions_inquiry;
ALTER TABLE guest_sessions DROP COLUMN IF EXISTS inquiry_id;
ALTER TABLE inquiries DROP COLUMN IF EXISTS merged_into;
ALTER TABLE customers DROP COLUMN IF EXISTS merged_into;
