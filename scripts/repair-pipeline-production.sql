-- Run manually only after migration 0002 and the corrected Worker are deployed.
-- This does not touch movies, relations, enrichments, embeddings, or provenance.

-- Historical hourly discovery jobs are obsolete. Their Queue deliveries become
-- harmless: the corrected consumer only runs a job it can atomically claim as queued.
UPDATE pipeline_jobs
SET status='done',
    completed_at=CURRENT_TIMESTAMP,
    last_error='superseded during stable discovery-key recovery',
    updated_at=CURRENT_TIMESTAMP
WHERE type='DISCOVER_QUERY' AND status IN ('queued','running');

-- Release query leases left by those obsolete jobs. Imported provenance remains
-- explicitly disabled and is never changed into executable discovery work.
UPDATE collection_queries
SET status='pending',
    last_error='released during pipeline congestion recovery',
    updated_at=CURRENT_TIMESTAMP
WHERE is_executable=1 AND status='running';

UPDATE collection_queries
SET is_executable=0, status='imported', next_run_at=NULL, updated_at=CURRENT_TIMESTAMP
WHERE status='imported' OR query_id LIKE 'legacy-%';
