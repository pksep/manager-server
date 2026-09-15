DROP TABLE IF EXISTS inquiry_metadata_events;
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiry_note_length, DROP CONSTRAINT IF EXISTS inquiry_manager_count;
ALTER TABLE inquiries DROP COLUMN IF EXISTS manager_ids, DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS metadata_version;
