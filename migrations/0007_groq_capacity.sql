CREATE TABLE IF NOT EXISTS groq_capacity (
 day TEXT PRIMARY KEY, server_rpd INTEGER NOT NULL DEFAULT 1000, server_tpm INTEGER NOT NULL DEFAULT 8000, attempts INTEGER NOT NULL DEFAULT 0,
 reserved_tokens INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 measured INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
 completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
 cached_tokens INTEGER NOT NULL DEFAULT 0, sum_squares REAL NOT NULL DEFAULT 0,
 histogram TEXT NOT NULL DEFAULT '{}', errors TEXT NOT NULL DEFAULT '{}',
 headers TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_movies_enriched_today ON movies(enriched_at) WHERE enrichment_status='complete';
