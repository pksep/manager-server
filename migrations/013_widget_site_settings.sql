CREATE TABLE widget_site_settings (
  site_id text PRIMARY KEY REFERENCES sites(id),
  settings jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
