CREATE TABLE top_global_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  source TEXT, reference_date TEXT, updated_at TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  allow_duplicates INTEGER NOT NULL DEFAULT 0,
  lease TEXT, lease_until TEXT,
  budget_day TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO top_global_state(id) VALUES(1);
CREATE TABLE top_global_tracks (
  spotify_id TEXT PRIMARY KEY,
  position INTEGER,
  title TEXT NOT NULL, artist TEXT NOT NULL, cover TEXT,
  lrclib_id TEXT, movement TEXT, delta INTEGER,
  tmdb_id INTEGER, movie_json TEXT,
  pending INTEGER NOT NULL DEFAULT 1,
  failure TEXT, attempted_at TEXT
);
CREATE UNIQUE INDEX top_global_position ON top_global_tracks(position) WHERE position IS NOT NULL;
