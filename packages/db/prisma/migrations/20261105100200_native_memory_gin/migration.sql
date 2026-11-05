-- Sole statement so the index builds outside an implicit transaction.
CREATE INDEX CONCURRENTLY "memory_facts_searchTokens_idx" ON "memory_facts" USING GIN ("searchTokens");
