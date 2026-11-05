-- Native semantic memory: atomic facts extracted from conversations, with encrypted
-- content, blind-index search tokens, and a pgvector embedding (untyped `vector`, so
-- switching embedding models re-embeds instead of locking the column to a dimension).
-- `botId` NULL is the Space's shared perspective; a set botId is that bot's own view.

CREATE TABLE "memory_facts" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT,
  "level" TEXT NOT NULL DEFAULT 'explicit',
  "status" TEXT NOT NULL DEFAULT 'active',
  "supersededById" TEXT,
  "occurredAt" TIMESTAMP(3),
  "content" TEXT NOT NULL,
  "searchTokens" INTEGER[],
  "embedding" vector,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_facts_level_check" CHECK ("level" IN ('explicit', 'deductive', 'inductive')),
  CONSTRAINT "memory_facts_status_check" CHECK ("status" IN ('active', 'superseded', 'expired')),
  CONSTRAINT "memory_facts_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_facts_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_facts_spaceId_botId_idx" ON "memory_facts"("spaceId", "botId");
CREATE INDEX "memory_facts_spaceId_status_level_idx" ON "memory_facts"("spaceId", "status", "level");
CREATE INDEX "memory_facts_createdAt_idx" ON "memory_facts"("createdAt");
-- A superseded fact points at the fact that replaced it; the link is data, not an
-- enforced edge (the target can itself be superseded later), so no FK.
CREATE INDEX "memory_facts_supersededById_idx" ON "memory_facts"("supersededById");

-- Provenance graph: a derived fact was concluded from these source facts, in order.
CREATE TABLE "memory_fact_sources" (
  "derivedId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "memory_fact_sources_pkey" PRIMARY KEY ("derivedId", "sourceId"),
  CONSTRAINT "memory_fact_sources_derivedId_fkey" FOREIGN KEY ("derivedId")
    REFERENCES "memory_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_fact_sources_sourceId_idx" ON "memory_fact_sources"("sourceId");

-- Ingestion cursor: which messages of a thread the extractor has consumed.
CREATE TABLE "memory_thread_progress" (
  "threadId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "lastExtractedSeq" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "memory_thread_progress_pkey" PRIMARY KEY ("threadId"),
  CONSTRAINT "memory_thread_progress_threadId_fkey" FOREIGN KEY ("threadId")
    REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_thread_progress_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_thread_progress_spaceId_idx" ON "memory_thread_progress"("spaceId");

-- Deployment-wide state for the native memory service: embedding model settings and
-- lease columns, mirroring the pattern honcho_runtime_state used.
CREATE TABLE "native_memory_state" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "status" TEXT NOT NULL DEFAULT 'needs_configuration',
  "error" TEXT,
  "configuration" JSONB NOT NULL DEFAULT '{}',
  "embeddingSecretId" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "native_memory_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "native_memory_state_status_check" CHECK ("status" IN ('needs_configuration', 'connected', 'degraded')),
  CONSTRAINT "native_memory_state_embeddingSecretId_fkey" FOREIGN KEY ("embeddingSecretId")
    REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "native_memory_state_embeddingSecretId_key" ON "native_memory_state"("embeddingSecretId");

ALTER TABLE "memory_facts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_facts_tenant ON "memory_facts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_facts_system ON "memory_facts"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "memory_fact_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_fact_sources_tenant ON "memory_fact_sources"
  USING (EXISTS (
    SELECT 1 FROM "memory_facts" f
    WHERE f."id" = "memory_fact_sources"."derivedId"
      AND f."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY memory_fact_sources_system ON "memory_fact_sources"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "memory_thread_progress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_thread_progress_tenant ON "memory_thread_progress"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_thread_progress_system ON "memory_thread_progress"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "native_memory_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY native_memory_state_system ON "native_memory_state"
  USING (current_setting('app.rls_bypass', true) = 'on');
