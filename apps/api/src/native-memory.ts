import type { SecretStore } from "@rakazo/adapter-kit";
import {
  NATIVE_PROVIDER_ID,
  type NativeMemoryStateView,
  readNativeMemoryState,
  updateNativeMemorySettings,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

export interface NativeMemoryDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
}

/** Resolves a NativeMemoryDeps from the router's shared deps object. */
export function nativeMemoryDeps(deps: {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
}): NativeMemoryDeps {
  return { prisma: deps.prisma, secrets: deps.secrets };
}

async function isDefaultSpaceOwner(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true, space: { select: { isDefault: true } } },
  });
  if (!member?.role.split(",").includes("owner")) return false;
  const owner = await prisma.spaceMember.findFirst({
    where: { userId: actor.userId, space: { isDefault: true }, role: { contains: "owner" } },
    select: { id: true },
  });
  return Boolean(member.space.isDefault || owner);
}

/** Only the personal Space owner configures the deployment-wide embedding endpoint. */
async function requireDefaultSpaceOwner(prisma: PrismaClient, actor: Actor) {
  if (!(await isDefaultSpaceOwner(prisma, actor))) {
    throw new Error("Only the personal Space owner can manage the native memory service.");
  }
}

export async function readNativeState(deps: NativeMemoryDeps) {
  return readNativeMemoryState(deps.prisma);
}

export async function updateNativeSettings(
  deps: NativeMemoryDeps,
  actor: Actor,
  input: { embeddingModel: string; embeddingBaseUrl: string; embeddingApiKey?: string },
): Promise<NativeMemoryStateView> {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  return updateNativeMemorySettings(deps, actor, input);
}

/**
 * Enables the native provider for a Space: a SpaceMemoryConfig row pointing at the
 * built-in provider, with a placeholder secret the resolver never reads.
 */
export async function enableNativeMemory(deps: NativeMemoryDeps, actor: Actor) {
  await withSerializableRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const existing = await tx.spaceMemoryConfig.findUnique({
        where: { spaceId: actor.spaceId },
      });
      if (existing) {
        await tx.spaceMemoryConfig.delete({ where: { spaceId: actor.spaceId } });
        if (existing.secretId) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
      }
      const stored = await deps.secrets.put(JSON.stringify({ native: true }), {
        operationId: "native-memory-enable",
        traceId: "native-memory-enable",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      });
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: "memory-provider",
          ciphertext: stored.ciphertext,
        },
      });
      await tx.spaceMemoryConfig.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          provider: NATIVE_PROVIDER_ID,
          settings: {},
          secretId: stored.id,
        },
      });
    }),
  );
}

/** Lists the observers a Space has facts for, for the browse UI's picker. */
export async function listNativeFactObservers(
  deps: Pick<NativeMemoryDeps, "prisma">,
  actor: Actor,
) {
  const { listFactObservers } = await import("@rakazo/adapters");
  const observers = await listFactObservers(deps.prisma, actor.spaceId);
  return { items: observers };
}

export async function listNativeFacts(
  deps: Pick<NativeMemoryDeps, "prisma">,
  actor: Actor,
  input: { query?: string; observer?: string; page?: number; size?: number },
) {
  const { listFacts } = await import("@rakazo/adapters");
  const page = input.page ?? 1;
  const size = input.size ?? 50;
  const facts = await listFacts(deps.prisma, {
    spaceId: actor.spaceId,
    observer: input.observer === undefined ? undefined : input.observer || null,
    limit: size,
    offset: (page - 1) * size,
  });
  return {
    items: facts.map((fact) => ({
      id: fact.id,
      content: fact.content,
      observer: fact.botId ?? "shared",
      level: fact.level as "explicit" | "deductive" | "inductive",
      createdAt: fact.createdAt.toISOString(),
      ...(fact.distance !== undefined ? { distance: fact.distance } : {}),
    })),
    page,
    size,
  };
}

export async function createNativeFact(
  deps: NativeMemoryDeps,
  actor: Actor,
  input: { content: string; observer: string },
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  const { resolveEmbeddingConnection, EmbeddingClient, insertFacts } = await import(
    "@rakazo/adapters"
  );
  const connection = await resolveEmbeddingConnection(deps);
  if (!connection) throw new Error("Configure the embedding endpoint before writing facts.");
  const client = new EmbeddingClient(connection);
  const { embedding } = await client.embed(input.content);
  await insertFacts(deps.prisma, [
    {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: input.observer === "shared" ? null : input.observer,
      level: "explicit",
      content: input.content,
      metadata: { source: "manual" },
      embedding,
    },
  ]);
  return { ok: true as const };
}

export async function deleteNativeFact(
  deps: Pick<NativeMemoryDeps, "prisma">,
  actor: Actor,
  input: { factId: string },
) {
  const { deleteFact } = await import("@rakazo/adapters");
  const removed = await deleteFact(deps.prisma, actor.spaceId, input.factId);
  if (!removed) throw new Error("No memory with that id was found.");
  return { ok: true as const };
}
