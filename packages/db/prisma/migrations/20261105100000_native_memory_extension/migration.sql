-- The native memory provider stores fact embeddings in pgvector, in this database.
--
-- `CREATE EXTENSION` needs a superuser, and Rakazo's migration role is not one. So the
-- extension is expected to exist already: the compose stack's Postgres image ships the
-- package (and the image's owner login creates it), local development creates it from
-- scripts/dev.mjs, and self-hosts install the package and create it once.
--
-- This migration therefore only proves the extension is usable, and says exactly what to
-- do when it is missing instead of failing later at the first write.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      RAISE EXCEPTION 'pgvector is required for memory but is not installed in this Postgres. Install the postgresql-<major>-pgvector package for your Postgres build (the compose stack image already includes it), then run migrations again.';
    END IF;
    -- The package is installed but the extension is not created in this database.
    BEGIN
      CREATE EXTENSION vector;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'pgvector is installed but this database does not have the extension, and the migration role cannot create it (superuser required). Create it once as a superuser: CREATE EXTENSION vector;  then run migrations again.';
    END;
  END IF;
END $$;
