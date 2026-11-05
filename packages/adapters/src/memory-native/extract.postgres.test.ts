import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractThreadMemories } from "./extract.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const spaceId = "extract-space";
const userId = "extract-user";
const botId = "extract-bot";
const threadId = "extract-thread";

/** A runtime that answers every completion with the given JSON. */
function fakeRuntime(json: string): AgentRuntime {
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: false } as never,
    }),
    async *run(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "done", text: json } as AgentRuntimeEvent;
    },
    async abort() {},
  };
}

describePostgres("thread memory extraction (PostgreSQL)", () => {
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
        name: "Extract Test Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Extract Test Space",
            bots: {
              create: { id: botId, userId, name: "Extract Test Bot", color: "ink" },
            },
            threads: {
              create: { id: threadId, userId, botId },
            },
          },
        },
      },
    });
    await runAsSystem("seed extraction messages", () =>
      prisma.message.createMany({
        data: [
          {
            id: "extract-message-0",
            threadId,
            seq: 0,
            role: "user",
            blocks: [{ kind: "text", text: "I always book the window seat on flights." }],
          },
          {
            id: "extract-message-1",
            threadId,
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "Also my assistant is called Juniper." }],
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await asSystem(prisma).organization.deleteMany({ where: { id: spaceId } });
    } finally {
      await close();
    }
  });

  const embeddingFor = async () => ({
    baseUrl: "https://embed.test/v1",
    apiKey: "k",
    model: "m",
  });
  const resolveModel = async () => ({ provider: "fake", id: "fake" });
  // Embeddings come from a stub fetch, so no network is touched.
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("writes each fact for both observers and advances the cursor", async () => {
    const result = await extractThreadMemories(
      {
        prisma,
        runtime: fakeRuntime(
          JSON.stringify({
            facts: [
              { content: "The user always books the window seat on flights." },
              { content: "The user's assistant is called Juniper." },
            ],
          }),
        ),
        embeddingFor,
        resolveModel,
        fetchImpl: fetchImpl as never,
      },
      threadId,
    );
    expect(result.extracted).toBe(2);

    const facts = await runAsSystem("read extracted facts", () =>
      prisma.memoryFact.findMany({ where: { spaceId }, select: { content: true, botId: true } }),
    );
    // One row per fact, in the perspective its scope names: this Space is isolated, so
    // everything lands under the bot. Writing both perspectives stored each fact twice.
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => fact.botId === botId)).toBe(true);
    expect(facts.some((fact) => fact.content.includes("window seat"))).toBe(true);
    // The same fact must never appear twice, or shared recall returns it twice.
    const contents = facts.map((fact) => fact.content);
    expect(new Set(contents).size).toBe(contents.length);

    const progress = await runAsSystem("read cursor", () =>
      prisma.memoryThreadProgress.findUnique({ where: { threadId } }),
    );
    expect(progress?.lastExtractedSeq).toBe(1);
  });

  it("does not re-extract already consumed messages", async () => {
    const second = await extractThreadMemories(
      {
        prisma,
        runtime: fakeRuntime(JSON.stringify({ facts: [] })),
        embeddingFor,
        resolveModel,
        fetchImpl: fetchImpl as never,
      },
      threadId,
    );
    expect(second).toEqual({ extracted: 0, skipped: "nothing-new" });
  });
});
