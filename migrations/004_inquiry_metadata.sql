ALTER TABLE inquiries ADD COLUMN manager_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE inquiries ADD COLUMN note text NOT NULL DEFAULT '';
ALTER TABLE inquiries ADD COLUMN metadata_version integer NOT NULL DEFAULT 0;
ALTER TABLE inquiries ADD CONSTRAINT inquiry_note_length CHECK (char_length(note) <= 10000);
ALTER TABLE inquiries ADD CONSTRAINT inquiry_manager_count CHECK (cardinality(manager_ids) <= 20);
UPDATE inquiries SET manager_ids=ARRAY[assignee_id] WHERE assignee_id IS NOT NULL;
CREATE TABLE inquiry_metadata_events (
  id uuid PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES inquiries(id),
  actor_id uuid NOT NULL,
  previous_value jsonb NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inquiry_metadata_events_inquiry ON inquiry_metadata_events(inquiry_id,created_at);
