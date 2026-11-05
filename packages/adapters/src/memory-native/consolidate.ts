import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { EmbeddingConnection } from "./embedding-client.js";
import { memoryComplete, parseMemoryJson } from "./llm.js";
import { expireFacts, supersedeFacts } from "./store.js";

/** Facts one consolidation pass adjudicates together. */
export const CONSOLIDATE_BATCH_FACTS = 40;
/** Fewer new facts than this since the last pass are not worth a model call. */
export const CONSOLIDATE_MIN_NEW_FACTS = 20;

export interface MemoryConsolidateDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  }) => Promise<AgentRunRequest["model"]>;
  /** Only for symmetry with extraction; consolidation writes no embeddings. */
  embeddingFor?: (spaceId: string) => Promise<EmbeddingConnection | null>;
}

/** The decisions one consolidation pass can take about a batch of facts. */
export type ConsolidationAction =
  | { kind: "supersede"; ids: string[]; byId: string; reason: string }
  | { kind: "expire"; ids: string[]; reason: string }
  | { kind: "keep" };

const DECISION_SCHEMA = `{"superseded":[{"olderIds":["<id>"],"newerId":"<id>","reason":"<why>"}],"expired":[{"ids":["<id>"],"reason":"<why>"}]}`;

const DECISION_SYSTEM = [
  "You maintain a long-term memory store. You are given a batch of stored facts, each with an id.",
  "Return only JSON matching the user's schema: no prose, no markdown fences.",
  "",
  "Rules:",
  "- superseded: the newer fact makes the older one false or out of date (the user moved, changed a preference, replaced a tool). The newer fact states the current truth; the older ones are historical.",
  "- expired: the fact was only true of a moment that has passed (an event that already happened, a temporary state, a one-off plan that is over). Do not expire standing truths or recurring facts.",
  "- Never list a fact as both newest and superseded. Never invent ids.",
  "- Return empty arrays when nothing should change; most batches need no action.",
].join("\n");

interface FactRow {
  id: string;
  content: string;
  occurredAt: Date | null;
  createdAt: Date;
}

/** Facts written since the observer's last pass, oldest first. */
async function pendingFacts(
  prisma: PrismaClient,
  spaceId: string,
  botId: string | null,
  limit: number,
): Promise<FactRow[]> {
  return prisma.memoryFact.findMany({
    where: { spaceId, botId, status: "active" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, content: true, occurredAt: true, createdAt: true },
  });
}

function parseDecision(
  value: unknown,
  knownIds: Set<string>,
): { superseded: { olderIds: string[]; newerId: string; reason: string }[]; expired: string[] } {
  const record = value as { superseded?: unknown; expired?: unknown };
  const superseded: { olderIds: string[]; newerId: string; reason: string }[] = [];
  if (Array.isArray(record.superseded)) {
    for (const raw of record.superseded) {
      const entry = raw as { olderIds?: unknown; newerId?: unknown; reason?: unknown };
      if (!Array.isArray(entry.olderIds) || typeof entry.newerId !== "string") continue;
      // Both ends must be in this batch, so a hallucinated id can never rewrite another observer.
      if (!knownIds.has(entry.newerId)) continue;
      const olderIds = entry.olderIds.filter(
        (id): id is string => typeof id === "string" && knownIds.has(id) && id !== entry.newerId,
      );
      if (olderIds.length === 0) continue;
      superseded.push({
        olderIds,
        newerId: entry.newerId,
        reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : "",
      });
    }
  }
  const expired: string[] = [];
  if (Array.isArray(record.expired)) {
    for (const raw of record.expired) {
      const entry = raw as { ids?: unknown };
      if (!Array.isArray(entry.ids)) continue;
      for (const id of entry.ids) {
        if (typeof id === "string" && knownIds.has(id)) expired.push(id);
      }
    }
  }
  return { superseded, expired };
}

/**
 * Folds a batch of an observer's facts together: repeated or outdated statements get
 * superseded by their replacement, and facts whose moment has passed expire. Recall
 * only ever reads `active`, so a pass removes stale knowledge without deleting history.
 */
export async function consolidateObserverMemories(
  deps: MemoryConsolidateDeps,
  input: { spaceId: string; userId: string; botId: string | null },
): Promise<{ superseded: number; expired: number; skipped?: string }> {
  return runAsSystem("native memory consolidation", async () => {
    const facts = await pendingFacts(
      deps.prisma,
      input.spaceId,
      input.botId,
      CONSOLIDATE_BATCH_FACTS,
    );
    if (facts.length === 0) return { superseded: 0, expired: 0, skipped: "no-facts" };

    const model = await deps.resolveModel({
      userId: input.userId,
      spaceId: input.spaceId,
      ...(input.botId ? { botId: input.botId } : {}),
    });
    const prompt = [
      "Stored facts (id, first seen, occurred at, text):",
      ...facts.map(
        (fact) =>
          `- id=${fact.id} first_seen=${fact.createdAt.toISOString()} occurred_at=${fact.occurredAt?.toISOString() ?? "unknown"}\n  ${fact.content}`,
      ),
      "",
      `Reply with JSON only, exactly this shape: ${DECISION_SCHEMA}`,
      "Use empty arrays when nothing should change.",
    ].join("\n");

    const completion = await memoryComplete({
      runtime: deps.runtime,
      model,
      scope: {
        spaceId: input.spaceId,
        userId: input.userId,
        ...(input.botId ? { botId: input.botId } : {}),
      },
      system: DECISION_SYSTEM,
      prompt,
      operationKind: "memory.consolidate",
      operationId: `memory.consolidate:${input.spaceId}:${input.botId ?? "shared"}`,
    });
    if (!completion.ok) throw new Error(completion.error);
    const parsed = parseMemoryJson(completion.text);
    if (!parsed.ok) throw new Error("The consolidation model returned invalid JSON.");

    const decision = parseDecision(parsed.value, new Set(facts.map((fact) => fact.id)));
    let superseded = 0;
    for (const action of decision.superseded) {
      superseded += await supersedeFacts(
        deps.prisma,
        input.spaceId,
        action.olderIds,
        action.newerId,
      );
    }
    const expired = await expireFacts(deps.prisma, input.spaceId, decision.expired);
    if (superseded > 0 || expired > 0) {
      getLogger().info("native memory consolidated", {
        spaceId: input.spaceId,
        botId: input.botId ?? "shared",
        superseded,
        expired,
      });
    }
    return { superseded, expired };
  });
}

/**
 * Observers due for a consolidation pass: each distinct observer with at least
 * `CONSOLIDATE_MIN_NEW_FACTS` active facts. The caller decides cadence.
 */
export async function observersDueForConsolidation(
  prisma: PrismaClient,
  spaceId: string,
): Promise<(string | null)[]> {
  const rows = await runAsSystem("native memory consolidation scan", () =>
    prisma.memoryFact.groupBy({
      by: ["botId"],
      where: { spaceId, status: "active" },
      _count: { _all: true },
    }),
  );
  return rows.filter((row) => row._count._all >= CONSOLIDATE_MIN_NEW_FACTS).map((row) => row.botId);
}
