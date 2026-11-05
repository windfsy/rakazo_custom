import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { EmbeddingConnection } from "./embedding-client.js";
import { EmbeddingClient } from "./embedding-client.js";
import { memoryComplete, parseMemoryJson } from "./llm.js";
import { insertFacts } from "./store.js";

/** Source facts one dream reasons over. */
export const DREAM_BATCH_FACTS = 50;
/** Below this many active explicit facts an observer has nothing worth generalizing. */
export const DREAM_MIN_EXPLICIT_FACTS = 50;

export interface MemoryDreamDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  embeddingFor: (spaceId: string) => Promise<EmbeddingConnection | null>;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  }) => Promise<AgentRunRequest["model"]>;
  fetchImpl?: typeof globalThis.fetch;
}

interface DerivedFact {
  content: string;
  level: "deductive" | "inductive";
  sourceIds: string[];
}

const DREAM_SCHEMA = `{"facts":[{"content":"<a new conclusion>","level":"deductive|inductive","sourceIds":["<fact id>","<fact id>"]}]}`;

const DREAM_SYSTEM = [
  "You consolidate a long-term memory store by drawing conclusions its stored facts support.",
  "Return only JSON matching the user's schema: no prose, no markdown fences.",
  "",
  "- deductive: a conclusion that follows necessarily from the cited facts (dates that imply an ordering, constraints that imply a consequence).",
  "- inductive: a pattern the cited facts support (a recurring preference, a stable habit, a relationship).",
  "- Cite the ids the conclusion rests on; at least one for deductive and at least two for inductive.",
  "- Each conclusion must be one self-contained statement in the facts' language, and must add information the cited facts do not state directly.",
  "- Never restate a fact, never generalize from a single instance as inductive, and never cite an id that is not in the list.",
  "- Return an empty array when the facts support no new conclusion; most batches support none.",
].join("\n");

function parseDerived(value: unknown, knownIds: Set<string>): DerivedFact[] {
  const raw = (value as { facts?: unknown }).facts;
  if (!Array.isArray(raw)) return [];
  const facts: DerivedFact[] = [];
  for (const entry of raw) {
    const record = entry as { content?: unknown; level?: unknown; sourceIds?: unknown };
    if (typeof record.content !== "string") continue;
    const content = record.content.trim();
    if (content.length < 12) continue;
    if (record.level !== "deductive" && record.level !== "inductive") continue;
    if (!Array.isArray(record.sourceIds)) continue;
    const sourceIds = [
      ...new Set(
        record.sourceIds.filter((id): id is string => typeof id === "string" && knownIds.has(id)),
      ),
    ];
    const minimum = record.level === "inductive" ? 2 : 1;
    if (sourceIds.length < minimum) continue;
    facts.push({ content, level: record.level, sourceIds });
  }
  return facts;
}

/**
 * Runs one dream for an observer: reads its strongest explicit facts, asks the model
 * for conclusions they support, and stores each with its provenance edges. Derived
 * facts are written level `deductive`/`inductive`, so recall can cite the chain.
 */
export async function dreamObserverMemories(
  deps: MemoryDreamDeps,
  input: { spaceId: string; userId: string; botId: string | null },
): Promise<{ derived: number; skipped?: string }> {
  return runAsSystem("native memory dream", async () => {
    const sources = await deps.prisma.memoryFact.findMany({
      where: { spaceId: input.spaceId, botId: input.botId, status: "active" },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: DREAM_BATCH_FACTS,
      select: { id: true, content: true },
    });
    const explicit = sources.length;
    if (explicit === 0) return { derived: 0, skipped: "no-facts" };

    const embedding = await deps.embeddingFor(input.spaceId);
    if (!embedding) return { derived: 0, skipped: "not-configured" };
    const model = await deps.resolveModel({
      userId: input.userId,
      spaceId: input.spaceId,
      ...(input.botId ? { botId: input.botId } : {}),
    });

    const completion = await memoryComplete({
      runtime: deps.runtime,
      model,
      scope: {
        spaceId: input.spaceId,
        userId: input.userId,
        ...(input.botId ? { botId: input.botId } : {}),
      },
      system: DREAM_SYSTEM,
      prompt: [
        `Stored facts (${explicit}):`,
        ...sources.map((fact) => `- id=${fact.id}: ${fact.content}`),
        "",
        `Reply with JSON only, exactly this shape: ${DREAM_SCHEMA}`,
        "Use an empty facts array when nothing new is supported.",
      ].join("\n"),
      operationKind: "memory.dream",
      operationId: `memory.dream:${input.spaceId}:${input.botId ?? "shared"}`,
    });
    if (!completion.ok) throw new Error(completion.error);
    const parsed = parseMemoryJson(completion.text);
    if (!parsed.ok) return { derived: 0, skipped: "invalid-output" };

    const derived = parseDerived(parsed.value, new Set(sources.map((fact) => fact.id)));
    if (derived.length === 0) return { derived: 0 };

    const client = new EmbeddingClient(embedding, deps.fetchImpl);
    const embeddings = await client.embedBatch(derived.map((fact) => fact.content));
    const rows = derived.flatMap((fact, index) => {
      const vector = embeddings[index]?.embedding;
      if (!vector) return [];
      return [
        {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          level: fact.level,
          content: fact.content,
          metadata: { source: "dream", sources: fact.sourceIds },
          embedding: vector,
        },
      ];
    });
    const ids = await insertFacts(deps.prisma, rows);
    // Provenance: which facts each conclusion was drawn from.
    const edges = derived.flatMap((fact, index) => {
      const id = ids[index];
      if (!id) return [];
      return fact.sourceIds.map((sourceId, position) => ({
        derivedId: id,
        sourceId,
        position,
      }));
    });
    if (edges.length > 0) {
      await deps.prisma.memoryFactSource.createMany({ data: edges, skipDuplicates: true });
    }
    getLogger().info("native memory dream", {
      spaceId: input.spaceId,
      botId: input.botId ?? "shared",
      derived: ids.length,
      edges: edges.length,
    });
    return { derived: ids.length };
  });
}

/** Observers with enough explicit facts for a dream to add anything. */
export async function observersDueForDream(
  prisma: PrismaClient,
  spaceId: string,
): Promise<(string | null)[]> {
  const rows = await runAsSystem("native memory dream scan", () =>
    prisma.memoryFact.groupBy({
      by: ["botId"],
      where: { spaceId, status: "active", level: "explicit" },
      _count: { _all: true },
    }),
  );
  return rows.filter((row) => row._count._all >= DREAM_MIN_EXPLICIT_FACTS).map((row) => row.botId);
}

/** The provenance chain behind one derived fact, oldest edge first. */
export async function factProvenance(prisma: PrismaClient, derivedId: string): Promise<string[]> {
  // Provenance is read while assembling recall context, outside a request's tenant scope.
  const edges = await runAsSystem("native memory provenance", () =>
    prisma.memoryFactSource.findMany({
      where: { derivedId },
      orderBy: { position: "asc" },
      select: { sourceId: true },
    }),
  );
  return edges.map((edge) => edge.sourceId);
}
