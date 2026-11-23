-- Owner managed public events. Event images uploaded from the owner portal
-- are stored as bounded data URLs in D1 so Roger does not need another
-- service or a desktop upload flow for ordinary event flyers.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  image_data TEXT,
  signup_url TEXT,
  price_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_events_public_date ON events(status, event_date);
