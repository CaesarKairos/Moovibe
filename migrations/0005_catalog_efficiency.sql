-- Nullable, gradually populated metadata for the thin catalog. Existing
-- normalized relations remain readable and no backfill is performed.
ALTER TABLE movies ADD COLUMN director_name TEXT;
ALTER TABLE movies ADD COLUMN genres_json TEXT;
ALTER TABLE movies ADD COLUMN keywords_json TEXT;
ALTER TABLE movies ADD COLUMN countries_json TEXT;
ALTER TABLE movies ADD COLUMN languages_json TEXT;
