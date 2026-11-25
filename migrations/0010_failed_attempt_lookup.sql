-- The movie completion trigger checks failed attempts by TMDb ID.
-- Index only failed attempts to avoid adding index writes to successful jobs.
CREATE INDEX IF NOT EXISTS idx_attempts_failed_tmdb
ON pipeline_attempts(tmdb_id) WHERE outcome='failed';
