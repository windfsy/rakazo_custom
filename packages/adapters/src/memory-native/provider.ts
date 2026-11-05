import type {
  AdapterContext,
  SecretStore,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { contentEncryptionOf } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { EmbeddingClient } from "./embedding-client.js";
import type { MemoryRerankDeps } from "./rerank.js";
import { rerankFacts } from "./rerank.js";
import { NATIVE_PROVIDER_ID, resolveEmbeddingConnection } from "./state.js";
import { deleteFact, getFact, observerLabel, recallObservers, searchFacts } from "./store.js";

/** Recall asks the embedding endpoint once per run; keep the client per provider instance. */
export interface NativeMemoryDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "load">;
  /** When present, recall reorders its shortlist with the Space's main model. */
  rerank?: MemoryRerankDeps;
}

export class NativeMemoryProvider implements SemanticMemoryProvider {
  private embedding: Promise<EmbeddingClient | null> | null = null;

  constructor(private readonly deps: NativeMemoryDeps) {}

  private async embeddingClient(): Promise<EmbeddingClient | null> {
    if (!this.embedding) {
      this.embedding = resolveEmbeddingConnection(this.deps).then(
        (connection) => (connection ? new EmbeddingClient(connection) : null),
        (error) => {
          getLogger().warn("native memory embedding resolution failed", { error });
          return null;
        },
      );
    }
    return this.embedding;
  }

  describe() {
    return {
      id: NATIVE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      } as const,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    if (!request.query.trim()) return { ok: true, value: [] };
    const client = await this.embeddingClient();
    if (!client) return { ok: false, error: "Native memory is not configured." };
    const encryption = contentEncryptionOf(this.deps.prisma);
    if (!encryption) return { ok: false, error: "Content encryption is unavailable." };
    try {
      const { embedding } = await client.embed(request.query);
      // One token list per space key version; each arm ORs the versions.
      const tokenLists = await encryption.messageSearchTokens(
        context.spaceId,
        request.query,
        "word",
      );
      const facts = await searchFacts(this.deps.prisma, {
        spaceId: context.spaceId,
        observers: recallObservers(request.scope, request.botId),
        queryEmbedding: embedding,
        tokenLists,
        limit: request.limit,
      });
      // The fused order is the fallback; the model may reorder but never widen it.
      const ordered = this.deps.rerank
        ? await rerankFacts(this.deps.rerank, {
            query: request.query,
            facts,
            scope: { spaceId: context.spaceId, userId: context.userId, botId: request.botId },
          })
        : facts;
      return {
        ok: true,
        value: ordered.map((fact) => ({
          memory: fact.content,
          // Bumped by the model's order: earlier results score higher.
          score: fact.distance === undefined ? 1 : 1 - fact.distance,
          id: fact.id,
          provenance: "native",
          entity: observerLabel(fact.botId),
        })),
      };
    } catch (error) {
      getLogger().warn("native memory recall failed", { error });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Native memory recall failed.",
      };
    }
  }

  async save(
    request: SemanticMemorySaveRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Durable saves come from the bot's save_memory tool; history summaries stay in
    // Rakazo's own compaction store and are never written here.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Native memory save skipped: empty content." };
    const client = await this.embeddingClient();
    if (!client) return { ok: false, error: "Native memory is not configured." };
    try {
      const { embedding } = await client.embed(content);
      const { insertFacts } = await import("./store.js");
      // The scope names the perspective, exactly as recall reads it: a shared-scope save
      // joins the Space pool so other bots see it; an isolated one stays the bot's own.
      await insertFacts(this.deps.prisma, [
        {
          spaceId: _context.spaceId,
          userId: _context.userId,
          botId: request.scope === "shared" ? null : request.botId,
          level: "explicit",
          content,
          metadata: { source: "save_memory" },
          embedding,
          embeddingModel: client.model,
        },
      ]);
      return { ok: true, value: undefined };
    } catch (error) {
      getLogger().warn("native memory save failed", { error });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Native memory save failed.",
      };
    }
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const id = request.id.trim();
    if (!id) return { ok: false, error: "id is required" };
    const observers = recallObservers(request.scope, request.botId);
    if (
      request.entity &&
      !observers.some((observer) => observerLabel(observer) === request.entity)
    ) {
      return { ok: false, error: "That memory belongs to another bot or Space." };
    }
    try {
      const fact = await getFact(this.deps.prisma, context.spaceId, id);
      if (fact?.status !== "active" || !observers.includes(fact.botId)) {
        return { ok: false, error: "No memory with that id was found in this bot's memory." };
      }
      const removed = await deleteFact(this.deps.prisma, context.spaceId, id);
      if (!removed) {
        return { ok: false, error: "No memory with that id was found in this bot's memory." };
      }
      return { ok: true, value: { id, expired: true, reason: request.reason ?? null } };
    } catch (error) {
      getLogger().warn("native memory forget failed", { error });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Native memory forget failed.",
      };
    }
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to native memory.
    return { ok: true, value: undefined };
  }
}

export function createNativeProvider(deps: NativeMemoryDeps): SemanticMemoryProvider {
  return new NativeMemoryProvider(deps);
}
