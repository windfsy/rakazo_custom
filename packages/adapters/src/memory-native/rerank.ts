import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { memoryComplete, parseMemoryJson } from "./llm.js";
import type { NativeFact } from "./store.js";

/** Candidates the model reorders; more than this costs tokens without improving the top. */
export const RERANK_CANDIDATES = 20;
/** The reorder gets a short budget: recall runs inside a bot turn. */
const RERANK_TIMEOUT_MS = 8_000;

export interface MemoryRerankDeps {
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  }) => Promise<AgentRunRequest["model"]>;
}

const RERANK_SYSTEM = [
  "You rank stored facts by how well each answers a request.",
  'Return only JSON: {"relevantIds":["<id>"]} in order, most relevant first.',
  "Include only facts that genuinely help answer the request. Omit the rest.",
  "Never invent ids. Return an empty list when no fact helps.",
].join(" ");

/**
 * Reorders fused candidates with the Space's main model. Any failure — provider error,
 * malformed output, timeout, or no usable model — returns the fused order unchanged, so
 * recall degrades rather than blocking a run.
 */
export async function rerankFacts(
  deps: MemoryRerankDeps,
  input: {
    query: string;
    facts: NativeFact[];
    scope: { spaceId: string; userId: string; botId: string };
  },
): Promise<NativeFact[]> {
  if (input.facts.length <= 1) return input.facts;
  const candidates = input.facts.slice(0, RERANK_CANDIDATES);
  try {
    const model = await deps.resolveModel({
      userId: input.scope.userId,
      spaceId: input.scope.spaceId,
      botId: input.scope.botId,
    });
    if (model.provider === "scripted") return input.facts;
    const byId = new Map(candidates.map((fact) => [fact.id, fact]));
    const completion = await memoryComplete({
      runtime: deps.runtime,
      model,
      scope: input.scope,
      system: RERANK_SYSTEM,
      prompt: [
        `Request: ${input.query}`,
        "",
        "Stored facts:",
        ...candidates.map((fact) => `- id=${fact.id}: ${fact.content}`),
        "",
        'Reply with JSON only: {"relevantIds":[...]}',
      ].join("\n"),
      operationKind: "memory.rerank",
      operationId: `memory.rerank:${input.scope.spaceId}`,
      timeoutMs: RERANK_TIMEOUT_MS,
    });
    if (!completion.ok) return input.facts;
    const parsed = parseMemoryJson(completion.text);
    if (!parsed.ok) return input.facts;
    const ids = (parsed.value as { relevantIds?: unknown }).relevantIds;
    if (!Array.isArray(ids)) return input.facts;
    const ordered: NativeFact[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      const fact = byId.get(id);
      if (!fact) continue;
      seen.add(id);
      ordered.push(fact);
    }
    // A reorder that drops everything is not an answer; keep the fused order instead.
    return ordered.length > 0 ? ordered : input.facts;
  } catch (error) {
    getLogger().warn("native memory rerank failed; using fused order", { error });
    return input.facts;
  }
}
