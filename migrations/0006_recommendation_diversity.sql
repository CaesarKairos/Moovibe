ALTER TABLE recommendation_events ADD COLUMN music_key TEXT;
CREATE INDEX IF NOT EXISTS idx_recommendations_music_history
  ON recommendation_events(music_key, success, primary_tmdb_id, created_at DESC);
