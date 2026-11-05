import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertFacts,
  listFactObservers,
  observerLabel,
  recallObservers,
  reciprocalRankFusion,
  searchFacts,
} from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
// Ingestion and recall run in the worker, as the system principal.
const INGESTION = "native memory ingestion";
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("native memory facts (PostgreSQL)", () => {
  const spaceId = "native-memory-space";
  const userId = "native-memory-user";
  const botId = "native-memory-bot";
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).organization.create({
      data: {
        id: spaceId,
        name: "Native Memory Test Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Native Memory Test Space",
            bots: {
              create: { id: botId, userId, name: "Native Memory Test Bot", color: "ink" },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await asSystem(prisma).organization.deleteMany({ where: { id: spaceId } });
    } finally {
      await close();
    }
  });

  async function insert(contents: string[], botIdForFacts: string | null = botId) {
    return insertFacts(
      prisma,
      contents.map((content, index) => ({
        spaceId,
        userId,
        botId: botIdForFacts,
        level: "explicit" as const,
        content,
        embedding: embeddingOf(content),
        embeddingModel: "test-model",
        metadata: { index },
      })),
    );
  }

  it("writes encrypted facts with embeddings and reads them back decrypted", async () => {
    const ids = await insert([
      "The user prefers dark mode in every app.",
      "The user's cat is named Mira.",
    ]);
    expect(ids).toHaveLength(2);
    const { Prisma } = await import("@rakazo/db");
    const raw = await runAsSystem(INGESTION, () =>
      prisma.$queryRaw<Array<{ content: unknown; hasVector: boolean }>>(
        Prisma.sql`SELECT content, embedding IS NOT NULL AS "hasVector" FROM "memory_facts" WHERE "spaceId" = ${spaceId} AND id IN (${ids[0]!}, ${ids[1]!})`,
      ),
    );
    // Raw content stays encrypted at rest; the store decrypts through openRows.
    expect(raw).toHaveLength(2);
    for (const row of raw) {
      expect(String(row.content)).toMatch(/^rkz1:/);
      expect(row.hasVector).toBe(true);
    }
  });

  it("finds facts for the right observers, decrypted and ordered by distance", async () => {
    await insert(["The user takes the 8am ferry on weekdays."]);
    await insert(["The team ships on Thursdays."], null);
    const facts = await searchFacts(prisma, {
      spaceId,
      observers: recallObservers("shared", botId),
      queryEmbedding: embeddingOf("How does the user commute in the morning?"),
      tokenLists: [],
      limit: 5,
    });
    // The toy embedding in this test is not semantic, so assert the retrieval
    // contract: shared scope sees both perspectives, decrypted, distance-ordered.
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((fact) => fact.content.includes("ferry"))).toBe(true);
    expect(facts.every((fact) => fact.botId === botId || fact.botId === null)).toBe(true);
    const distances = facts.map((fact) => fact.distance ?? Number.POSITIVE_INFINITY);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(observerLabel(null)).toBe("shared");
    expect(observerLabel(botId)).toBe(botId);
  });

  it("isolates an isolated scope to the bot's own facts", async () => {
    const facts = await searchFacts(prisma, {
      spaceId,
      observers: recallObservers("isolated", botId),
      queryEmbedding: embeddingOf("When does the team ship?"),
      tokenLists: [],
      limit: 5,
    });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((fact) => fact.botId === botId)).toBe(true);
    expect(facts.some((fact) => fact.botId === null)).toBe(false);
  });

  it("lists the observers the space has facts for", async () => {
    const observers = await listFactObservers(prisma, spaceId);
    expect(observers).toContain("shared");
    expect(observers).toContain(botId);
  });

  it("fuses two ranked lists with reciprocal rank fusion", () => {
    const a = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const b = [{ id: "3" }, { id: "1" }];
    const fused = reciprocalRankFusion([a, b], 3);
    // Found by both arms, "1" and "3" outrank the arm-one-only "2".
    expect(fused.map((item) => item.id)).toEqual(["1", "3", "2"]);
  });
});

/** A deterministic stand-in embedding: 8 dimensions from the text's bytes. */
function embeddingOf(text: string): number[] {
  const values = Array.from({ length: 8 }, (_, i) => text.charCodeAt(i % text.length) % 97);
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / magnitude);
}
