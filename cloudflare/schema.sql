CREATE TABLE IF NOT EXISTS singleton (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  encrypted_session TEXT, rates TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO singleton(id) VALUES(1);
