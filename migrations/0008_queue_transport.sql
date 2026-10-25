-- Publication ownership is separate from execution attempts. Legacy queued jobs
-- wait one full Free retention window before repair to avoid duplicating backlog.
ALTER TABLE pipeline_jobs ADD COLUMN queue_lease_until TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN queue_publication_token TEXT;
UPDATE pipeline_jobs SET queue_lease_until=datetime('now','+25 hours') WHERE status='queued';
CREATE INDEX idx_pipeline_outbox ON pipeline_jobs(status,available_at,queue_lease_until);
CREATE TRIGGER pipeline_outbox_reset AFTER UPDATE OF status,available_at ON pipeline_jobs
WHEN NEW.status='queued' AND (OLD.status<>'queued' OR NEW.available_at IS NOT OLD.available_at)
BEGIN UPDATE pipeline_jobs SET queue_lease_until=NULL,queue_publication_token=NULL WHERE job_key=NEW.job_key; END;
CREATE TABLE queue_transport (
 id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL DEFAULT '',
 estimated_operations INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT, reason TEXT
);
INSERT INTO queue_transport(id) VALUES(1);
