-- Separate historical provenance labels from executable TMDb discovery queries.
ALTER TABLE collection_queries ADD COLUMN is_executable INTEGER NOT NULL DEFAULT 1 CHECK(is_executable IN (0,1));
UPDATE collection_queries
SET is_executable=0, status='imported', next_run_at=NULL, updated_at=CURRENT_TIMESTAMP
WHERE status='imported' OR query_id LIKE 'legacy-%';
DROP INDEX IF EXISTS idx_collection_queries_due;
CREATE INDEX IF NOT EXISTS idx_collection_queries_due
  ON collection_queries(is_executable,status,next_run_at);

-- Supports lease recovery without scanning completed history.
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_recovery
  ON pipeline_jobs(status,updated_at,type);
