import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { EmbeddingConnection } from "./embedding-client.js";
import { EmbeddingClient } from "./embedding-client.js";
import { factsNeedingReembedding, setFactEmbedding } from "./store.js";

/** Facts re-embedded per pass; a batch keeps one call bounded and the transaction short. */
const REEMBED_BATCH = 64;

/**
 * Re-embeds facts whose stored vector did not come from the configured model.
 *
 * Vectors from two models are not comparable even at the same dimension, so a settings
 * change marks the old ones stale rather than reusing them. Rows are rewritten one batch
 * at a time, and recall keeps working from the blind index for rows not yet updated.
 */
export async function reembedStaleFacts(
  prisma: PrismaClient,
  connection: EmbeddingConnection,
  fetchImpl?: typeof globalThis.fetch,
): Promise<{ reembedded: number }> {
  const client = new EmbeddingClient(connection, fetchImpl);
  let reembedded = 0;
  let afterId: string | undefined;
  for (;;) {
    const batch = await factsNeedingReembedding(prisma, {
      model: connection.model,
      limit: REEMBED_BATCH,
      ...(afterId ? { afterId } : {}),
    });
    if (batch.length === 0) break;
    const embeddings = await client.embedBatch(batch.map((fact) => fact.content));
    await runAsSystem("native memory reembed write", async () => {
      for (const [index, fact] of batch.entries()) {
        const vector = embeddings[index]?.embedding;
        if (vector) await setFactEmbedding(prisma, fact.id, vector, connection.model);
      }
    });
    reembedded += batch.length;
    afterId = batch[batch.length - 1]!.id;
    if (batch.length < REEMBED_BATCH) break;
  }
  if (reembedded > 0) {
    getLogger().info("native memory re-embedded stale facts", {
      model: connection.model,
      reembedded,
    });
  }
  return { reembedded };
}
