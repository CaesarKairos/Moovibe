-- Rolling minute reservations survive UTC rollover; daily counters remain separate.
ALTER TABLE groq_capacity ADD COLUMN server_daily_ceiling INTEGER NOT NULL DEFAULT 1000;
UPDATE groq_capacity SET server_daily_ceiling=server_rpd;
CREATE TABLE groq_admissions (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, admitted_at INTEGER NOT NULL,
 tokens INTEGER NOT NULL, actual_tokens INTEGER, reconciled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_groq_admissions_window ON groq_admissions(admitted_at);
CREATE TRIGGER groq_admission_account AFTER INSERT ON groq_admissions BEGIN
 UPDATE groq_capacity SET attempts=attempts+1,reserved_tokens=reserved_tokens+NEW.tokens WHERE day=NEW.day;
END;
CREATE TRIGGER groq_admission_reconcile AFTER UPDATE OF reconciled ON groq_admissions
WHEN OLD.reconciled=0 AND NEW.reconciled=1 AND NEW.actual_tokens IS NOT NULL BEGIN
 UPDATE groq_capacity SET reserved_tokens=reserved_tokens+NEW.actual_tokens-NEW.tokens WHERE day=NEW.day;
END;

ALTER TABLE pipeline_jobs ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'unpublished';
-- Existing leases are deliberately preserved: delivery ownership cannot be inferred.
UPDATE pipeline_jobs SET publication_state='legacy_wait' WHERE queue_lease_until IS NOT NULL;
CREATE TRIGGER pipeline_publication_reset AFTER UPDATE OF status,available_at ON pipeline_jobs
WHEN NEW.status='queued' AND (OLD.status<>'queued' OR NEW.available_at IS NOT OLD.available_at)
BEGIN UPDATE pipeline_jobs SET publication_state='unpublished' WHERE job_key=NEW.job_key; END;

CREATE TABLE pipeline_attempts (
 id INTEGER PRIMARY KEY, job_key TEXT NOT NULL, type TEXT NOT NULL, tmdb_id INTEGER,
 started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL DEFAULT 'running', error TEXT,
 legacy INTEGER NOT NULL DEFAULT 0, legacy_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_attempts_job ON pipeline_attempts(job_key,id);
CREATE TABLE pipeline_attempt_totals(id INTEGER PRIMARY KEY CHECK(id=1),total INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,successful INTEGER NOT NULL DEFAULT 0,deferred INTEGER NOT NULL DEFAULT 0);
INSERT INTO pipeline_attempt_totals(id) VALUES(1);
CREATE TRIGGER pipeline_attempt_count AFTER INSERT ON pipeline_attempts WHEN NEW.legacy=0 BEGIN
 UPDATE pipeline_attempt_totals SET total=total+1 WHERE id=1;
END;
CREATE TRIGGER pipeline_outcome_count AFTER UPDATE OF outcome ON pipeline_attempts WHEN OLD.outcome='running' AND NEW.outcome<>'running' AND NEW.legacy=0 BEGIN
 UPDATE pipeline_attempt_totals SET failed=failed+(NEW.outcome='failed'),successful=successful+(NEW.outcome='success'),deferred=deferred+(NEW.outcome='deferred') WHERE id=1;
END;
-- Preserve the original terminal error before explicit recovery clears the job row.
INSERT INTO pipeline_attempts(job_key,type,tmdb_id,started_at,finished_at,outcome,error,legacy,legacy_attempts)
 SELECT job_key,type,json_extract(payload_json,'$.tmdb_id'),COALESCE(started_at,updated_at),updated_at,'failed',last_error,1,attempts
 FROM pipeline_jobs WHERE status='error';
CREATE TRIGGER pipeline_error_snapshot BEFORE UPDATE OF status ON pipeline_jobs
WHEN OLD.status='error' AND NEW.status='queued' AND NOT EXISTS(
 SELECT 1 FROM pipeline_attempts WHERE job_key=OLD.job_key AND error=OLD.last_error AND outcome='failed'
) BEGIN
 INSERT INTO pipeline_attempts(job_key,type,tmdb_id,started_at,finished_at,outcome,error,legacy,legacy_attempts)
 VALUES(OLD.job_key,OLD.type,json_extract(OLD.payload_json,'$.tmdb_id'),COALESCE(OLD.started_at,OLD.updated_at),OLD.updated_at,'failed',OLD.last_error,1,
 CASE WHEN EXISTS(SELECT 1 FROM pipeline_attempts WHERE job_key=OLD.job_key AND legacy=0) THEN 0 ELSE OLD.attempts END);
END;
CREATE TRIGGER pipeline_attempt_start AFTER UPDATE OF status ON pipeline_jobs
WHEN NEW.status='running' AND OLD.status<>'running' BEGIN
 INSERT INTO pipeline_attempts(job_key,type,tmdb_id,started_at) VALUES(NEW.job_key,NEW.type,json_extract(NEW.payload_json,'$.tmdb_id'),CURRENT_TIMESTAMP);
END;
CREATE TRIGGER pipeline_attempt_finish AFTER UPDATE OF status ON pipeline_jobs
WHEN OLD.status='running' AND NEW.status<>'running' BEGIN
 UPDATE pipeline_attempts SET finished_at=CURRENT_TIMESTAMP,
 outcome=CASE WHEN NEW.status='done' THEN 'success' WHEN NEW.attempts<OLD.attempts THEN 'deferred' ELSE 'failed' END,
 error=NEW.last_error WHERE job_key=NEW.job_key AND outcome='running';
END;
CREATE TABLE recovery_batches(id TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE recovery_items(batch_id TEXT NOT NULL REFERENCES recovery_batches(id),job_key TEXT NOT NULL,result TEXT,result_error TEXT,finished_at TEXT,PRIMARY KEY(batch_id,job_key));
CREATE TRIGGER recovery_result AFTER UPDATE OF status ON pipeline_jobs
WHEN OLD.status='running' AND NEW.status IN ('done','error') BEGIN
 UPDATE recovery_items SET result=NEW.status,result_error=NEW.last_error,finished_at=CURRENT_TIMESTAMP WHERE job_key=NEW.job_key AND result IS NULL;
END;
CREATE TABLE movie_completions(tmdb_id INTEGER PRIMARY KEY,completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,recovered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_movie_completions_at ON movie_completions(completed_at);
CREATE INDEX idx_movie_completions_recovered ON movie_completions(recovered);
-- Historical rows are not counted as new completions on migration day.
INSERT INTO movie_completions(tmdb_id,completed_at) SELECT tmdb_id,COALESCE(embedded_at,updated_at) FROM movies
 WHERE collection_status='complete' AND enrichment_status='complete' AND embedding_status='complete';
CREATE TRIGGER movie_pipeline_complete AFTER UPDATE OF collection_status,enrichment_status,embedding_status ON movies
WHEN NEW.collection_status='complete' AND NEW.enrichment_status='complete' AND NEW.embedding_status='complete' BEGIN
 INSERT INTO movie_completions(tmdb_id,recovered) VALUES(NEW.tmdb_id,EXISTS(SELECT 1 FROM pipeline_attempts WHERE tmdb_id=NEW.tmdb_id AND outcome='failed')) ON CONFLICT(tmdb_id) DO NOTHING;
 UPDATE movies SET last_error=NULL WHERE id=NEW.id;
END;
