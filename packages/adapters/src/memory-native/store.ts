import type { DurableMemoryScope } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { contentEncryptionOf, Prisma, runAsSystem } from "@rakazo/db";

/** Facts a recall can see: shared scope reads the Space pool plus the bot's own view. */
export function recallObservers(scope: DurableMemoryScope, botId: string): (string | null)[] {
  return scope === "shared" ? [null, botId] : [botId];
}

/** The label cited in recall results so `forget_memory` can target the fact it came from. */
export function observerLabel(observer: string | null): string {
  return observer ?? "shared";
}

export interface NativeFactInput {
  spaceId: string;
  userId: string;
  /** NULL is the Space's shared perspective. */
  botId: string | null;
  level: "explicit" | "deductive" | "inductive";
  content: string;
  occurredAt?: Date | null;
  metadata?: Record<string, unknown>;
  embedding: number[];
  /** The model that produced `embedding`; a later change re-embeds these rows. */
  embeddingModel: string;
}

export interface NativeFact {
  id: string;
  botId: string | null;
  level: string;
  status: string;
  content: string;
  occurredAt: Date | null;
  createdAt: Date;
  /** Cosine distance from the query vector (0 identical); semantic arm results only. */
  distance?: number;
}

/**
 * `spaceId` and `userId` are the encryption context: openRows resolves the space's
 * data key from them, so every raw fact read selects them beside the fields.
 */
const FACT_COLUMNS = `id, "spaceId", "userId", "botId", level, status, content, "occurredAt", "createdAt"`;

function requireEncryption(prisma: PrismaClient) {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) {
    throw new Error("Native memory requires a database client with content encryption.");
  }
  return encryption;
}

/**
 * Inserts facts: the encrypted content and blind-index tokens go through Prisma so the
 * content-encryption extension seals them; the pgvector embedding lands through raw SQL
 * afterwards, in the same transaction. Ingestion is workspace-level work that names the
 * space on every row, so it runs as the system principal.
 */
export async function insertFacts(
  prisma: PrismaClient,
  facts: NativeFactInput[],
): Promise<string[]> {
  if (facts.length === 0) return [];
  return runAsSystem("native memory ingestion", () =>
    prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const fact of facts) {
        const row = await tx.memoryFact.create({
          data: {
            spaceId: fact.spaceId,
            userId: fact.userId,
            botId: fact.botId,
            level: fact.level,
            status: "active",
            content: fact.content,
            occurredAt: fact.occurredAt ?? null,
            metadata: (fact.metadata ?? {}) as Prisma.InputJsonValue,
            embeddingModel: fact.embeddingModel,
          },
          select: { id: true },
        });
        await tx.$executeRaw`UPDATE "memory_facts" SET embedding = ${embeddingLiteral(fact.embedding)}::vector WHERE id = ${row.id}`;
        ids.push(row.id);
      }
      return ids;
    }),
  );
}

function embeddingLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Raw rows carry ciphertext; this decrypts and returns them as facts. */
async function openFactRows(
  prisma: PrismaClient,
  rows: Array<Record<string, unknown>>,
): Promise<NativeFact[]> {
  const encryption = requireEncryption(prisma);
  const opened = await encryption.openRows(
    "MemoryFact",
    rows as Array<{ id: string; userId: string }>,
  );
  return (opened as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    botId: (row.botId as string | null) ?? null,
    level: String(row.level),
    status: String(row.status),
    content: String(row.content),
    occurredAt: (row.occurredAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    ...(typeof row.distance === "number" ? { distance: row.distance } : {}),
  }));
}

const SEMANTIC_ARM_LIMIT = 50;
const TOKEN_ARM_LIMIT = 50;

/**
 * Two retrieval arms fused with Reciprocal Rank Fusion: pgvector cosine distance over
 * the embedding, and the blind-index tokens over the encrypted content. A fact found by
 * both arms ranks above one found by either.
 */
export async function searchFacts(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    observers: (string | null)[];
    queryEmbedding: number[];
    /** Blind-index token lists, one per space key version; a match must contain one list. */
    tokenLists: number[][];
    limit: number;
  },
): Promise<NativeFact[]> {
  const encryption = requireEncryption(prisma);
  const observers = [...new Set(input.observers)];
  const vector = embeddingLiteral(input.queryEmbedding);
  const hasTokens = input.tokenLists.some((tokens) => tokens.length > 0);

  const semanticPromise = (async () => {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.raw(FACT_COLUMNS)}, embedding <=> ${vector}::vector AS distance
      FROM "memory_facts"
      WHERE "spaceId" = ${input.spaceId}
        AND status = 'active'
        AND "botId" IN (${Prisma.join(
          observers.map((o) => Prisma.sql`${o}`),
          ", ",
        )})
        AND embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${SEMANTIC_ARM_LIMIT}
    `);
    return openFactRows(prisma, rows);
  })();

  const tokenPromise = hasTokens
    ? (async () => {
        // One branch per key version, mirroring historyMatch: a row matches when its
        // tokens contain every token of one version's list.
        const branches = Prisma.join(
          input.tokenLists.map((tokens) => Prisma.sql`"searchTokens" @> ${tokens}::int[]`),
          " OR ",
        );
        const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT ${Prisma.raw(FACT_COLUMNS)}
          FROM "memory_facts"
          WHERE "spaceId" = ${input.spaceId}
            AND status = 'active'
            AND "botId" IN (${Prisma.join(
              observers.map((o) => Prisma.sql`${o}`),
              ", ",
            )})
            AND (${branches})
          ORDER BY "createdAt" DESC
          LIMIT ${TOKEN_ARM_LIMIT}
        `);
        return openFactRows(prisma, rows);
      })()
    : Promise.resolve([]);

  const [semantic, token] = await Promise.all([semanticPromise, tokenPromise]);
  void encryption;

  return reciprocalRankFusion([semantic, token], input.limit);
}

/** score(d) = Σ 1 / (k + rank); ties keep the semantic arm's order. */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: T[][],
  limit: number,
  k = 60,
): T[] {
  const scores = new Map<string, number>();
  const first = new Map<string, T>();
  lists.forEach((list) => {
    list.forEach((item, index) => {
      if (!first.has(item.id)) first.set(item.id, item);
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + index + 1));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => first.get(id)!)
    .filter(Boolean);
}

/** Lists active facts for the browse UI, newest first, optionally filtered by observer. */
export async function listFacts(
  prisma: PrismaClient,
  input: { spaceId: string; observer?: string | null; limit: number; offset?: number },
): Promise<NativeFact[]> {
  const observerFilter =
    input.observer === undefined
      ? Prisma.empty
      : input.observer === null
        ? Prisma.sql`AND "botId" IS NULL`
        : Prisma.sql`AND "botId" = ${input.observer}`;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT ${Prisma.raw(FACT_COLUMNS)}
    FROM "memory_facts"
    WHERE "spaceId" = ${input.spaceId} AND status = 'active' ${observerFilter}
    ORDER BY "createdAt" DESC
    LIMIT ${input.limit} OFFSET ${input.offset ?? 0}
  `);
  return openFactRows(prisma, rows);
}

/** One fact by id, decrypted; only within the caller's RLS scope. */
export async function getFact(
  prisma: PrismaClient,
  spaceId: string,
  id: string,
): Promise<NativeFact | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT ${Prisma.raw(FACT_COLUMNS)}
    FROM "memory_facts"
    WHERE "spaceId" = ${spaceId} AND id = ${id}
  `);
  const [fact] = await openFactRows(prisma, rows);
  return fact ?? null;
}

/** Soft-deletes a fact; forgetting is permanent from recall's point of view. */
export async function deleteFact(prisma: PrismaClient, spaceId: string, id: string) {
  const result = await prisma.memoryFact.updateMany({
    where: { id, spaceId, status: "active" },
    data: { status: "expired" },
  });
  return result.count > 0;
}

/** The observers a space has facts for, so the browse UI can offer them. */
export async function listFactObservers(prisma: PrismaClient, spaceId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ botId: string | null }>>`
    SELECT DISTINCT "botId" FROM "memory_facts"
    WHERE "spaceId" = ${spaceId} AND status = 'active'
    ORDER BY "botId" ASC NULLS FIRST
  `;
  return rows.map((row) => row.botId ?? "shared");
}

/**
 * Marks facts superseded by a newer fact, keeping the chain for provenance.
 * Runs as the system principal: consolidation acts across the space's facts.
 */
export async function supersedeFacts(
  prisma: PrismaClient,
  spaceId: string,
  supersededIds: string[],
  supersededById: string,
): Promise<number> {
  if (supersededIds.length === 0) return 0;
  return runAsSystem("native memory consolidation", async () => {
    const result = await prisma.memoryFact.updateMany({
      where: { id: { in: supersededIds }, spaceId, status: "active" },
      data: { status: "superseded", supersededById },
    });
    return result.count;
  });
}

/** Expires temporal facts whose moment has passed. */
export async function expireFacts(
  prisma: PrismaClient,
  spaceId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.memoryFact.updateMany({
    where: { id: { in: ids }, spaceId, status: "active" },
    data: { status: "expired" },
  });
  return result.count;
}

/** Active fact counts per observer, for consolidation scheduling. */
export async function countActiveFacts(
  prisma: PrismaClient,
  spaceId: string,
  observer: string | null,
): Promise<number> {
  const where = {
    spaceId,
    status: "active" as const,
    ...(observer === null ? { botId: null } : { botId: observer }),
  };
  return prisma.memoryFact.count({ where });
}

/**
 * Facts whose vector did not come from `model`, so a model change re-embeds exactly the
 * stale rows. Rows with no recorded model predate the column and are stale too.
 */
export async function factsNeedingReembedding(
  prisma: PrismaClient,
  input: { model: string; limit: number; afterId?: string },
): Promise<Array<{ id: string; content: string }>> {
  // A rebuild scans every Space, so it runs as the system principal.
  return runAsSystem("native memory reembed scan", async () => {
    const stale = await prisma.$queryRaw<Array<{ id: string; content: string }>>(Prisma.sql`
      SELECT id, content, "spaceId", "userId" FROM "memory_facts"
      WHERE status = 'active'
        AND ("embeddingModel" IS NULL OR "embeddingModel" <> ${input.model})
        ${input.afterId ? Prisma.sql`AND id > ${input.afterId}` : Prisma.empty}
      ORDER BY id ASC
      LIMIT ${input.limit}
    `);
    // Content is encrypted at rest; decrypt before it is sent to the embedding endpoint.
    return requireEncryption(prisma).openRows("MemoryFact", stale);
  });
}

/** Clears every stored vector; recall falls back to the blind index until they are rewritten. */
export async function clearFactEmbeddings(prisma: PrismaClient): Promise<number> {
  // A rebuild clears every Space's vectors, so it runs as the system principal.
  const rows = await runAsSystem(
    "native memory clear vectors",
    () =>
      prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH updated AS (
        UPDATE "memory_facts"
        SET embedding = NULL, "embeddingModel" = NULL
        WHERE embedding IS NOT NULL
        RETURNING 1
      )
      SELECT count(*) AS count FROM updated
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Rewrites one fact's vector and records the model that produced it. */
export async function setFactEmbedding(
  prisma: PrismaClient,
  id: string,
  embedding: number[],
  embeddingModel: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "memory_facts"
    SET embedding = ${embeddingLiteral(embedding)}::vector, "embeddingModel" = ${embeddingModel}
    WHERE id = ${id}
  `;
}
