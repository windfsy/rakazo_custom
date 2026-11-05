import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { EmbeddingConnection } from "./embedding-client.js";
import { EmbeddingClient } from "./embedding-client.js";
import { memoryComplete, parseMemoryJson } from "./llm.js";
import { insertFacts } from "./store.js";

/** Messages one extraction call reads; older ones stay for the next pass. */
export const EXTRACT_BATCH_MESSAGES = 40;
/** Shortest message worth extracting from (acknowledgements carry no durable fact). */
const MIN_MESSAGE_CHARS = 8;
/** Facts longer than this are clipped before embedding; the embedding cap is bytes, not chars. */
const MAX_FACT_CHARS = 4_000;

export interface MemoryExtractDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  /** Resolves a connection per space; null when the provider is not configured. */
  embeddingFor: (spaceId: string) => Promise<EmbeddingConnection | null>;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  }) => Promise<AgentRunRequest["model"]>;
  /** Test seam: the embedding HTTP transport. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface ExtractedFact {
  content: string;
  occurredAt?: string;
}

const EXTRACT_SCHEMA = `{"facts":[{"content":"<one self-contained fact>","occurredAt":"<ISO date when the fact is true of a moment, else omit>"}]}`;

const EXTRACT_SYSTEM = [
  "You extract durable facts from a conversation for a long-term memory system.",
  "Return only JSON matching the shape the user describes: no prose, no markdown fences.",
  "Each fact must be one independent, self-contained statement that will still make sense months later.",
  "Write facts in the language of the conversation. Resolve every pronoun, relative date and pointer to its antecedent.",
  "Skip greetings, acknowledgements, questions, tool mechanics, and anything true of nearly everyone.",
  "Skip facts already present in the preceding context. Only what is new and worth recalling.",
].join(" ");

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks as MessageBlock[]) {
    if (block.kind === "text") parts.push(block.text);
    else if (block.kind === "subagent" && "task" in block) parts.push(String(block.task ?? ""));
  }
  return parts.join("\n").trim();
}

/** One conversation turn's text with its author and time, as the model will read it. */
function formatTurn(role: string, text: string, createdAt: Date): string {
  return `<turn role="${role}" time="${createdAt.toISOString()}">\n${text}\n</turn>`;
}

export function isValidExtractedFact(value: unknown): value is ExtractedFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  if (typeof fact.content !== "string") return false;
  const content = fact.content.trim();
  if (content.length < MIN_MESSAGE_CHARS) return false;
  if (fact.occurredAt !== undefined && typeof fact.occurredAt !== "string") return false;
  return true;
}

/**
 * Extracts durable facts from a thread's messages past the ingestion cursor and
 * writes them for the thread's bot. The cursor advances only after the facts are
 * committed, so a failed pass re-reads the same messages instead of losing them.
 */
export async function extractThreadMemories(
  deps: MemoryExtractDeps,
  threadId: string,
): Promise<{ extracted: number; skipped: string } | { extracted: number; skipped?: undefined }> {
  // Extraction is workspace-level work that names its space on every write, and the
  // job may arrive before a request sets a tenant: run as the system principal.
  return runAsSystem("native memory extraction", () => extract(deps, threadId));
}

async function extract(
  deps: MemoryExtractDeps,
  threadId: string,
): Promise<{ extracted: number; skipped: string } | { extracted: number; skipped?: undefined }> {
  const thread = await deps.prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { id: true, spaceId: true, userId: true, botId: true, historyCompactionSummary: true },
  });
  if (!thread.botId) return { extracted: 0, skipped: "no-bot" };

  const progress = await deps.prisma.memoryThreadProgress.findUnique({
    where: { threadId },
  });
  const fromSeq = progress?.lastExtractedSeq ?? -1;

  const messages = await deps.prisma.message.findMany({
    where: { threadId, seq: { gt: fromSeq } },
    orderBy: { seq: "asc" },
    take: EXTRACT_BATCH_MESSAGES,
    select: { id: true, seq: true, role: true, blocks: true, createdAt: true },
  });
  if (messages.length === 0) return { extracted: 0, skipped: "nothing-new" };

  const turns = messages
    .map((message) => ({
      seq: message.seq,
      text: blocksText(message.blocks),
      role: message.role,
      createdAt: message.createdAt,
    }))
    .filter((turn) => turn.text.length >= MIN_MESSAGE_CHARS);
  const latestSeq = messages[messages.length - 1]!.seq;
  if (turns.length === 0) {
    await advanceCursor(deps.prisma, threadId, thread.spaceId, latestSeq);
    return { extracted: 0, skipped: "nothing-new" };
  }

  const embedding = await deps.embeddingFor(thread.spaceId);
  if (!embedding) return { extracted: 0, skipped: "not-configured" };

  const model = await deps.resolveModel({
    userId: thread.userId,
    spaceId: thread.spaceId,
    botId: thread.botId,
  });

  const context = thread.historyCompactionSummary?.trim();
  const prompt = [
    context ? `Earlier conversation summary (context only, do not re-extract):\n${context}` : "",
    "New conversation turns:",
    ...turns.map((turn) => formatTurn(turn.role, turn.text, turn.createdAt)),
    "",
    `Reply with JSON only, exactly this shape: ${EXTRACT_SCHEMA}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = await memoryComplete({
    runtime: deps.runtime,
    model,
    scope: { spaceId: thread.spaceId, userId: thread.userId, botId: thread.botId },
    system: EXTRACT_SYSTEM,
    prompt,
    operationKind: "memory.extract",
    operationId: `memory.extract:${threadId}:${latestSeq}`,
  });
  if (!completion.ok) {
    // Leave the cursor in place: the job retry re-reads this batch.
    throw new Error(completion.error);
  }
  const parsed = parseMemoryJson(completion.text);
  if (!parsed.ok) throw new Error("The extraction model returned invalid JSON.");
  const raw = (parsed.value as { facts?: unknown }).facts;
  const facts = Array.isArray(raw) ? raw.filter(isValidExtractedFact) : [];
  if (facts.length === 0) {
    await advanceCursor(deps.prisma, threadId, thread.spaceId, latestSeq);
    return { extracted: 0, skipped: "no-facts" };
  }

  const client = new EmbeddingClient(embedding, deps.fetchImpl);
  const embeddings = await client.embedBatch(
    facts.map((fact) => fact.content.slice(0, MAX_FACT_CHARS)),
  );

  // Ingestion writes the Space's shared view and the bot's own view side by side, so
  // isolated recall stays complete and shared recall sees the whole pool.
  const rows = facts.flatMap((fact, index) => {
    const vector = embeddings[index]?.embedding;
    if (!vector) return [];
    return [null, thread.botId].map((botId) => ({
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      level: "explicit" as const,
      content: fact.content.slice(0, MAX_FACT_CHARS),
      occurredAt: parseOccurredAt(fact.occurredAt),
      metadata: { source: "conversation", threadId, seq: latestSeq },
      embedding: vector,
      embeddingModel: embedding.model,
    }));
  });
  await insertFacts(deps.prisma, rows);
  await advanceCursor(deps.prisma, threadId, thread.spaceId, latestSeq);
  getLogger().info("native memory extracted", {
    threadId,
    facts: facts.length,
    upToSeq: latestSeq,
  });
  return { extracted: facts.length };
}

function parseOccurredAt(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function advanceCursor(prisma: PrismaClient, threadId: string, spaceId: string, seq: number) {
  await runAsSystem("native memory ingest cursor", () =>
    prisma.memoryThreadProgress.upsert({
      where: { threadId },
      create: { threadId, spaceId, lastExtractedSeq: seq },
      update: { lastExtractedSeq: seq },
    }),
  );
}
