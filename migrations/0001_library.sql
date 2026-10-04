PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  original_title TEXT,
  overview TEXT,
  release_date TEXT,
  release_year INTEGER,
  original_language TEXT,
  runtime INTEGER,
  popularity REAL,
  vote_average REAL,
  vote_count INTEGER,
  poster_path TEXT,
  backdrop_path TEXT,
  tagline TEXT,
  tmdb_status TEXT,
  homepage TEXT,
  imdb_id TEXT,
  adult INTEGER NOT NULL DEFAULT 0 CHECK(adult IN (0,1)),
  video INTEGER NOT NULL DEFAULT 0 CHECK(video IN (0,1)),
  collection_status TEXT NOT NULL DEFAULT 'discovered',
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  details_fetched_at TEXT,
  enriched_at TEXT,
  embedded_at TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_schema_version TEXT,
  semantic_document_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_movies_pipeline ON movies(collection_status,enrichment_status,embedding_status);
CREATE INDEX IF NOT EXISTS idx_movies_year ON movies(release_year);
CREATE INDEX IF NOT EXISTS idx_movies_quality ON movies(vote_count,vote_average);

CREATE TABLE IF NOT EXISTS genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS movie_genres (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE, genre_id INTEGER NOT NULL REFERENCES genres(id), PRIMARY KEY(movie_id,genre_id));
CREATE INDEX IF NOT EXISTS idx_movie_genres_genre ON movie_genres(genre_id,movie_id);

CREATE TABLE IF NOT EXISTS countries (iso_3166_1 TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS movie_countries (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE, country_code TEXT NOT NULL REFERENCES countries(iso_3166_1), PRIMARY KEY(movie_id,country_code));
CREATE INDEX IF NOT EXISTS idx_movie_countries_country ON movie_countries(country_code,movie_id);

CREATE TABLE IF NOT EXISTS languages (iso_639_1 TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS movie_languages (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE, language_code TEXT NOT NULL REFERENCES languages(iso_639_1), PRIMARY KEY(movie_id,language_code));

CREATE TABLE IF NOT EXISTS keywords (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS movie_keywords (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE, keyword_id INTEGER NOT NULL REFERENCES keywords(id), PRIMARY KEY(movie_id,keyword_id));
CREATE INDEX IF NOT EXISTS idx_movie_keywords_keyword ON movie_keywords(keyword_id,movie_id);

CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, original_name TEXT, known_for_department TEXT);
CREATE TABLE IF NOT EXISTS movie_credits (movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE, person_id INTEGER NOT NULL REFERENCES people(id), department TEXT, job TEXT, character TEXT, credit_order INTEGER, PRIMARY KEY(movie_id,person_id,department,job,character));
CREATE INDEX IF NOT EXISTS idx_movie_credits_director ON movie_credits(job,movie_id);

CREATE TABLE IF NOT EXISTS collection_queries (
  query_id TEXT PRIMARY KEY, label TEXT NOT NULL, params_json TEXT NOT NULL,
  next_page INTEGER NOT NULL DEFAULT 1, total_pages INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT, next_run_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collection_queries_due ON collection_queries(status,next_run_at);

CREATE TABLE IF NOT EXISTS movie_discovery_sources (
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  query_id TEXT NOT NULL REFERENCES collection_queries(query_id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(movie_id,query_id)
);

CREATE TABLE IF NOT EXISTS movie_enrichments (
  movie_id INTEGER PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
  moods_json TEXT NOT NULL DEFAULT '[]', themes_json TEXT NOT NULL DEFAULT '[]', atmosphere_json TEXT NOT NULL DEFAULT '[]',
  visual_style_json TEXT NOT NULL DEFAULT '[]', pace TEXT,
  emotional_valence REAL, energy REAL, intimacy REAL, surrealism REAL, darkness REAL,
  humor REAL, romanticism REAL, narrative_density REAL, melancholy_level REAL, tension_level REAL,
  confidence REAL NOT NULL DEFAULT 0, model TEXT NOT NULL, schema_version TEXT NOT NULL,
  source_context TEXT, provenance_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  job_key TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, available_at TEXT, started_at TEXT, completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status ON pipeline_jobs(status,type,updated_at);

CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
