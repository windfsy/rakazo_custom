-- Which model produced a fact's vector. Two models' vectors are not comparable even at
-- the same dimension, so a settings change re-embeds the rows whose model differs.
ALTER TABLE "memory_facts" ADD COLUMN "embeddingModel" TEXT;
CREATE INDEX "memory_facts_embeddingModel_idx" ON "memory_facts"("embeddingModel");
