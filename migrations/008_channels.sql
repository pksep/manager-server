CREATE TABLE channel_connections (
  id text PRIMARY KEY, platform text NOT NULL CHECK(platform IN ('vk','avito')),
  account_id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  last_event_at timestamptz, last_error text, UNIQUE(platform,account_id)
);
CREATE TABLE reply_routes (
  id uuid PRIMARY KEY, channel text NOT NULL CHECK(channel IN ('widget','vk','avito')),
  connection_id text REFERENCES channel_connections(id), inquiry_id uuid REFERENCES inquiries(id),
  external_chat_id text, external_user_id text, source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_inbound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,external_chat_id),
  CHECK ((channel='widget' AND connection_id IS NULL AND external_chat_id IS NULL)
    OR (channel<>'widget' AND connection_id IS NOT NULL AND external_chat_id IS NOT NULL AND external_user_id IS NOT NULL))
);
INSERT INTO reply_routes(id,channel,inquiry_id,source,created_at,last_inbound_at)
SELECT id,'widget',inquiry_id,source,created_at,created_at FROM guest_sessions;
CREATE INDEX reply_routes_inquiry ON reply_routes(inquiry_id,last_inbound_at DESC);
ALTER TABLE inquiries DROP CONSTRAINT inquiries_session_id_fkey;
ALTER TABLE inquiries ADD CONSTRAINT inquiries_route_fkey FOREIGN KEY(session_id) REFERENCES reply_routes(id);
ALTER TABLE inquiries ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT messages_session_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_route_fkey FOREIGN KEY(session_id) REFERENCES reply_routes(id);
ALTER TABLE attachments DROP CONSTRAINT attachments_session_id_fkey;
ALTER TABLE attachments ADD CONSTRAINT attachments_route_fkey FOREIGN KEY(session_id) REFERENCES reply_routes(id);
ALTER TABLE customer_identities ALTER COLUMN site_id DROP NOT NULL;
CREATE TABLE channel_customers (
  connection_id text NOT NULL REFERENCES channel_connections(id), external_user_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id), PRIMARY KEY(connection_id,external_user_id)
);
CREATE TABLE channel_inbox (
  id uuid PRIMARY KEY, connection_id text NOT NULL REFERENCES channel_connections(id),
  event_key text NOT NULL, payload jsonb NOT NULL, normalized jsonb, state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','working','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, lease_token uuid, queued_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,event_key)
);
CREATE INDEX channel_inbox_pending ON channel_inbox(next_attempt_at) WHERE state IN ('pending','working');
CREATE TABLE channel_outbox (
  id uuid PRIMARY KEY REFERENCES messages(id), inquiry_id uuid NOT NULL REFERENCES inquiries(id),
  route_id uuid NOT NULL REFERENCES reply_routes(id), state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','working','delivered','failed','uncertain')),
  progress jsonb NOT NULL DEFAULT '[]', sending_part integer, random_id serial UNIQUE,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, lease_token uuid, queued_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_outbox_pending ON channel_outbox(next_attempt_at) WHERE state IN ('pending','working');
CREATE TABLE channel_message_receipts (
  connection_id text NOT NULL REFERENCES channel_connections(id), external_chat_id text NOT NULL,
  external_message_id text NOT NULL, message_id uuid NOT NULL REFERENCES messages(id),
  PRIMARY KEY(connection_id,external_chat_id,external_message_id)
);
