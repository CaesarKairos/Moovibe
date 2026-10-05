CREATE TABLE IF NOT EXISTS recommendation_events (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  language TEXT NOT NULL,
  songs_json TEXT NOT NULL,
  primary_tmdb_id INTEGER,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  candidate_count INTEGER,
  semantic_count INTEGER,
  numeric_count INTEGER,
  union_count INTEGER,
  final_count INTEGER,
  keyword_fallback_count INTEGER,
  duration_ms INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK(cache_hit IN (0,1)),
  success INTEGER NOT NULL CHECK(success IN (0,1)),
  error_code TEXT,
  error_message TEXT,
  top_candidates_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendation_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_success ON recommendation_events(success,created_at DESC);

