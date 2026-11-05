import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readNativeMemoryState, resolveEmbeddingConnection } from "./state.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const spaceId = "native-state-space";
const userId = "native-state-user";

describePostgres("native memory deployment state (PostgreSQL)", () => {
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
        name: "Native State Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Native State Space" } },
      },
    });
    await runAsSystem("seed native state", () =>
      prisma.nativeMemoryState.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          status: "connected",
          configuration: {
            embeddingModel: "stub-model",
            embeddingBaseUrl: "https://embed.test/v1",
            embeddingDimensions: 1536,
          },
        },
        update: {
          status: "connected",
          configuration: {
            embeddingModel: "stub-model",
            embeddingBaseUrl: "https://embed.test/v1",
            embeddingDimensions: 1536,
          },
        },
      }),
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await runAsSystem("cleanup native state", () =>
        prisma.nativeMemoryState.deleteMany({ where: { id: "default" } }),
      );
      await asSystem(prisma).organization.deleteMany({ where: { id: spaceId } });
    } finally {
      await close();
    }
  });

  // The deployment-wide row has only a system-bypass policy, so a tenant-scoped read
  // sees nothing. These two calls happen inside a bot run, under that tenant scope.
  it("reads the connected state from inside a tenant scope", async () => {
    const state = await runAsTenant({ spaceId, userId }, () => readNativeMemoryState(prisma));
    expect(state.status).toBe("connected");
    expect(state.settings.embeddingModel).toBe("stub-model");
  });

  it("resolves the embedding connection from inside a tenant scope", async () => {
    const connection = await runAsTenant({ spaceId, userId }, () =>
      resolveEmbeddingConnection({
        prisma,
        secrets: { load: async () => "unused-key" },
      }),
    );
    expect(connection?.model).toBe("stub-model");
    expect(connection?.baseUrl).toBe("https://embed.test/v1");
    expect(connection?.dimensions).toBe(1536);
  });
});
