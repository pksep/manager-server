CREATE TABLE support_clients (
  client_id text PRIMARY KEY,
  site_id text NOT NULL UNIQUE REFERENCES sites(id),
  guest_session_id uuid NOT NULL UNIQUE REFERENCES guest_sessions(id),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id),
  inquiry_id uuid NOT NULL UNIQUE REFERENCES inquiries(id)
);
