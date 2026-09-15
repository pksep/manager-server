DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM reply_routes WHERE channel<>'widget') THEN
    RAISE EXCEPTION 'Откат требует предварительного переноса переписки внешних каналов';
  END IF;
END $$;
DROP TABLE channel_message_receipts, channel_outbox, channel_inbox, channel_customers;
ALTER TABLE attachments DROP CONSTRAINT attachments_route_fkey;
ALTER TABLE attachments ADD CONSTRAINT attachments_session_id_fkey FOREIGN KEY(session_id) REFERENCES guest_sessions(id);
ALTER TABLE messages DROP CONSTRAINT messages_route_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY(session_id) REFERENCES guest_sessions(id);
ALTER TABLE inquiries DROP CONSTRAINT inquiries_route_fkey;
ALTER TABLE inquiries ADD CONSTRAINT inquiries_session_id_fkey FOREIGN KEY(session_id) REFERENCES guest_sessions(id);
ALTER TABLE inquiries ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE customer_identities ALTER COLUMN site_id SET NOT NULL;
DROP TABLE reply_routes, channel_connections;
