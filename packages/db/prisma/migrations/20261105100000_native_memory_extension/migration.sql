-- The native memory provider stores fact embeddings in pgvector, in this database.
-- The compose stack's Postgres image ships the package; a self-host on a stock
-- image fails here with guidance instead of a confusing error at first write.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'pgvector is required for the native memory provider but is not installed in this Postgres (check pg_available_extensions). Install the postgresql-<major>-pgvector package for your Postgres build, or use the compose stack image, then run migrations again.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS vector;
