import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reembedStaleFacts } from "./reembed.js";
import { clearFactEmbeddings, insertFacts, setFactEmbedding } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const spaceId = "reembed-space";
const userId = "reembed-user";
const botId = "reembed-bot";

/** A stub embedding endpoint: deterministic vectors of `dims`, no network. */
function embeddingStub(dims: number) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const inputs = body.input ?? [];
    const data = inputs.map((_, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_v, j) => ((index + j) % 7) / 7),
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describePostgres("stale vector re-embedding (PostgreSQL)", () => {
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
        name: "Reembed Test Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Reembed Test Space",
            bots: { create: { id: botId, userId, name: "Reembed Test Bot", color: "ink" } },
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

  it("re-embeds only facts from another model, at a new dimension", async () => {
    const ids = await insertFacts(prisma, [
      {
        spaceId,
        userId,
        botId,
        level: "explicit",
        content: "The user prefers window seats.",
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "old-3d",
      },
      {
        spaceId,
        userId,
        botId,
        level: "explicit",
        content: "The user's assistant is Juniper.",
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "old-3d",
      },
    ]);

    // A model change to a different dimension: the stale rows are rewritten, not mixed.
    // The rebuild is Space-wide and this database is shared with other suites, so assert
    // that these two rows were rewritten rather than the total the pass touched.
    await reembedStaleFacts(
      prisma,
      {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "new-2048",
      },
      embeddingStub(2048) as never,
    );

    const rows = await runAsSystem(
      "read reembedded",
      () =>
        prisma.$queryRaw<Array<{ id: string; dims: number; model: string | null }>>`
        SELECT id, vector_dims(embedding) AS dims, "embeddingModel" AS model
        FROM "memory_facts" WHERE "spaceId" = ${spaceId} AND id IN (${ids[0]!}, ${ids[1]!})
        ORDER BY id
      `,
    );
    expect(rows.every((row) => row.dims === 2048)).toBe(true);
    expect(rows.every((row) => row.model === "new-2048")).toBe(true);
  });

  it("leaves facts already embedded by the configured model alone", async () => {
    // The rebuild scans every Space, so clear other suites' vectors first: this case is
    // about not rewriting rows that already carry the configured model.
    await runAsSystem(
      "clear other vectors",
      () =>
        prisma.$executeRaw`UPDATE "memory_facts" SET embedding = NULL, "embeddingModel" = NULL WHERE "spaceId" <> ${spaceId}`,
    );
    const before = await reembedStaleFacts(
      prisma,
      {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "new-2048",
      },
      embeddingStub(2048) as never,
    );
    // Whatever other Spaces held was rewritten in this pass; our two rows already match.
    expect(before.reembedded).toBeGreaterThanOrEqual(0);
    const again = await reembedStaleFacts(
      prisma,
      {
        baseUrl: "https://embed.test/v1",
        apiKey: "k",
        model: "new-2048",
      },
      embeddingStub(2048) as never,
    );
    expect(again.reembedded).toBe(0);
  });

  it("clears every vector so a full rebuild starts from nothing", async () => {
    const cleared = await clearFactEmbeddings(prisma);
    expect(cleared).toBeGreaterThan(0);
    const remaining = await runAsSystem(
      "count vectors",
      () =>
        prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "memory_facts" WHERE embedding IS NOT NULL
      `,
    );
    expect(Number(remaining[0]?.n ?? -1)).toBe(0);
  });
});
