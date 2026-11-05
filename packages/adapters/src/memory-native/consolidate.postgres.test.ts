import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consolidateObserverMemories } from "./consolidate.js";
import { dreamObserverMemories, factProvenance } from "./dream.js";
import { insertFacts } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const spaceId = "consolidate-space";
const userId = "consolidate-user";
const botId = "consolidate-bot";

function runtimeAnswering(text: string) {
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {} as never,
    }),
    async *run() {
      yield { type: "done", text } as never;
    },
    async abort() {},
  };
}

const resolveModel = async () => ({ provider: "fake", id: "fake" });
const embeddingFor = async () => ({ baseUrl: "https://e.test/v1", apiKey: "k", model: "m" });
const fetchImpl = async () =>
  new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.11, 0.22] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describePostgres("native memory consolidation and dreaming (PostgreSQL)", () => {
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
        name: "Consolidate Test Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Consolidate Test Space",
            bots: { create: { id: botId, userId, name: "Consolidate Test Bot", color: "ink" } },
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

  async function seed(contents: string[]) {
    return insertFacts(
      prisma,
      contents.map((content) => ({
        spaceId,
        userId,
        botId,
        level: "explicit" as const,
        content,
        embedding: [0.1, 0.2],
      })),
    );
  }

  it("supersedes an outdated fact and expires a passed one", async () => {
    const [oldCity, movedCity, pastEvent] = await seed([
      "The user lives in Berlin.",
      "The user moved to Lisbon.",
      "The user has a dentist appointment on 2024-01-05.",
    ]);
    const result = await consolidateObserverMemories(
      {
        prisma,
        runtime: runtimeAnswering(
          JSON.stringify({
            superseded: [{ olderIds: [oldCity], newerId: movedCity, reason: "moved" }],
            expired: [{ ids: [pastEvent], reason: "date passed" }],
          }),
        ),
        resolveModel,
      },
      { spaceId, userId, botId },
    );
    expect(result).toEqual({ superseded: 1, expired: 1 });

    const rows = await runAsSystem("read statuses", () =>
      prisma.memoryFact.findMany({
        where: { spaceId, id: { in: [oldCity!, movedCity!, pastEvent!] } },
        select: { id: true, status: true, supersededById: true },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(oldCity!)?.status).toBe("superseded");
    expect(byId.get(oldCity!)?.supersededById).toBe(movedCity);
    expect(byId.get(movedCity!)?.status).toBe("active");
    expect(byId.get(pastEvent!)?.status).toBe("expired");
  });

  it("ignores ids outside the batch", async () => {
    const [known] = await seed(["The user prefers tea."]);
    const result = await consolidateObserverMemories(
      {
        prisma,
        runtime: runtimeAnswering(
          JSON.stringify({
            superseded: [{ olderIds: ["ghost-id"], newerId: known, reason: "x" }],
            expired: [{ ids: ["ghost-id"], reason: "x" }],
          }),
        ),
        resolveModel,
      },
      { spaceId, userId, botId },
    );
    expect(result).toEqual({ superseded: 0, expired: 0 });
  });

  it("derives a conclusion and records its provenance edges", async () => {
    const [first, second] = await seed([
      "The user visits Kyoto every April.",
      "The user visits Kyoto with family.",
    ]);
    const result = await dreamObserverMemories(
      {
        prisma,
        runtime: runtimeAnswering(
          JSON.stringify({
            facts: [
              {
                content: "The user has a recurring family trip to Kyoto each April.",
                level: "inductive",
                sourceIds: [first, second],
              },
            ],
          }),
        ),
        resolveModel,
        embeddingFor,
        fetchImpl: fetchImpl as never,
      },
      { spaceId, userId, botId },
    );
    expect(result.derived).toBe(1);

    const derived = await runAsSystem("read derived", () =>
      prisma.memoryFact.findFirst({
        where: { spaceId, botId, level: "inductive" },
        select: { id: true, content: true },
      }),
    );
    expect(derived?.content).toContain("Kyoto");
    const provenance = await factProvenance(prisma, derived!.id);
    expect(provenance).toEqual([first, second]);
  });

  it("drops a derived fact that cites unknown ids", async () => {
    const result = await dreamObserverMemories(
      {
        prisma,
        runtime: runtimeAnswering(
          JSON.stringify({
            facts: [
              {
                content: "An unsupported conclusion about the user.",
                level: "inductive",
                sourceIds: ["ghost"],
              },
            ],
          }),
        ),
        resolveModel,
        embeddingFor,
        fetchImpl: fetchImpl as never,
      },
      { spaceId, userId, botId },
    );
    expect(result.derived).toBe(0);
  });
});
