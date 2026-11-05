import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/** One bounded completion: the caller supplies the model and both prompt halves. */
export interface MemoryCompletionRequest {
  runtime: AgentRuntime;
  model: AgentRunRequest["model"];
  scope: { spaceId: string; userId: string; botId?: string };
  system: string;
  prompt: string;
  /** Tags usage records so memory jobs are attributable. */
  operationKind: string;
  operationId: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs one tool-free completion and returns its text. Memory work is best-effort
 * background work: a provider failure becomes a returned error, never an exception
 * that would strand the caller's cursor.
 */
export async function memoryComplete(
  request: MemoryCompletionRequest,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let text = "";
  try {
    for await (const event of request.runtime.run(
      {
        botId: request.scope.botId ?? "memory",
        threadId: `memory:${request.operationId}`,
        runId: request.operationId,
        usageOperationKind: "compaction",
        prompt: request.prompt,
        instructions: request.system,
        history: [],
        tools: [],
        model: request.model,
        allowSilentEmpty: true,
      },
      {
        operationId: request.operationId,
        traceId: request.operationId,
        spaceId: request.scope.spaceId,
        userId: request.scope.userId,
        signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    )) {
      if (event.type === "done" && event.text) text = event.text.trim();
    }
  } catch (error) {
    getLogger().warn("memory completion failed", { operationKind: request.operationKind, error });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The memory model call failed.",
    };
  }
  if (!text) return { ok: false, error: "The memory model returned no text." };
  return { ok: true, text };
}

/**
 * Reads a JSON object from model text. The model is asked for bare JSON, but a
 * fenced or prefaced block is common enough to recover rather than fail.
 */
export function parseMemoryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object") return { ok: true, value };
    } catch {
      // Try the next candidate shape.
    }
  }
  return { ok: false };
}
