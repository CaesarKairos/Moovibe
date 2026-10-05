PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL UNIQUE,
  lrclib_id TEXT UNIQUE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT,
  duration REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_songs_title_artist ON songs(title, artist);
CREATE INDEX IF NOT EXISTS idx_songs_updated ON songs(updated_at DESC);

CREATE TABLE IF NOT EXISTS song_lyrics (
  song_id INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  lyrics TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lrclib','genius','user')),
  source_reference TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_song_lyrics_source ON song_lyrics(source);

CREATE TABLE IF NOT EXISTS song_profiles (
  song_id INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL,
  model TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  source_lyrics_hash TEXT NOT NULL,
  embedding_json TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_song_profiles_validity ON song_profiles(schema_version, source_lyrics_hash, embedding_model, embedding_dimensions);

