-- Runs only on an empty data volume. The first TypeORM migration repeats these
-- statements with IF NOT EXISTS, so migrations stay the source of truth.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is STABLE, so it can't be used in an index/generated column directly.
-- This IMMUTABLE wrapper is for a future accent-folding keyword retriever.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
