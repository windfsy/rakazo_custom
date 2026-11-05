import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { type EmbeddingConnection, probeEmbeddingConnection } from "./embedding-client.js";

/** The native memory provider id, as persisted in SpaceMemoryConfig.provider. */
export const NATIVE_PROVIDER_ID = "native";

export type NativeMemoryStatus = "needs_configuration" | "connected" | "degraded";

/** The secret kind holding the embedding endpoint's API key. */
export const NATIVE_EMBEDDING_SECRET_KIND = "native-memory-embedding";

export interface NativeMemorySettings {
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  /** The model's own dimension, recorded from the probe; recall sends it back. */
  embeddingDimensions?: number;
}

export interface NativeMemoryStateView {
  status: NativeMemoryStatus;
  settings: NativeMemorySettings;
  error: string | null;
}

function settingsOf(configuration: unknown): NativeMemorySettings {
  const record = (configuration ?? {}) as Record<string, unknown>;
  return {
    ...(typeof record.embeddingModel === "string" ? { embeddingModel: record.embeddingModel } : {}),
    ...(typeof record.embeddingBaseUrl === "string"
      ? { embeddingBaseUrl: record.embeddingBaseUrl }
      : {}),
    ...(typeof record.embeddingDimensions === "number"
      ? { embeddingDimensions: record.embeddingDimensions }
      : {}),
  };
}

export async function readNativeMemoryState(
  prisma: Pick<PrismaClient, "nativeMemoryState">,
): Promise<NativeMemoryStateView> {
  const state = await prisma.nativeMemoryState.findUnique({ where: { id: "default" } });
  if (!state) {
    return { status: "needs_configuration", settings: {}, error: null };
  }
  return {
    status: state.status as NativeMemoryStatus,
    settings: settingsOf(state.configuration),
    error: state.error,
  };
}

/** Validates settings and probes the embedding endpoint through the real client path. */
export async function updateNativeMemorySettings(
  deps: { prisma: PrismaClient; secrets: Pick<SecretStore, "put"> },
  actor: { userId: string; spaceId: string },
  input: NativeMemorySettings & { embeddingApiKey?: string },
): Promise<NativeMemoryStateView> {
  const model = input.embeddingModel?.trim();
  const baseUrl = input.embeddingBaseUrl?.trim();
  if (!model) throw new Error("An embedding model is required.");
  if (!baseUrl) throw new Error("An embedding base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("The embedding base URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The embedding base URL must be HTTP or HTTPS.");
  }

  const probe = await probeEmbeddingConnection({
    baseUrl,
    apiKey: input.embeddingApiKey?.trim() || "probe",
    model,
  });
  if (!probe.ok) throw new Error(probe.error);

  const context: AdapterContext = {
    operationId: "native-memory-embedding",
    traceId: "native-memory-embedding",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  };
  await runAsSystem("native memory settings update", () =>
    deps.prisma.$transaction(async (tx) => {
      const existing = await tx.nativeMemoryState.findUnique({ where: { id: "default" } });
      let embeddingSecretId: string | undefined;
      if (input.embeddingApiKey?.trim()) {
        const stored = await deps.secrets.put(input.embeddingApiKey.trim(), context);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: NATIVE_EMBEDDING_SECRET_KIND,
            ciphertext: stored.ciphertext,
          },
        });
        embeddingSecretId = secret.id;
        if (existing?.embeddingSecretId) {
          await tx.secret.deleteMany({ where: { id: existing.embeddingSecretId } });
        }
      }
      const configuration = {
        embeddingModel: model,
        embeddingBaseUrl: baseUrl,
        embeddingDimensions: probe.dimensions,
      };
      await tx.nativeMemoryState.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          status: "connected",
          error: null,
          configuration,
          ...(embeddingSecretId ? { embeddingSecretId } : {}),
        },
        update: {
          status: "connected",
          error: null,
          configuration,
          ...(embeddingSecretId ? { embeddingSecretId } : {}),
        },
      });
    }),
  );
  return readNativeMemoryState(deps.prisma);
}

/** Loads the embedding connection for recall/ingestion; null until configured. */
export async function resolveEmbeddingConnection(deps: {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "load">;
}): Promise<EmbeddingConnection | null> {
  const state = await deps.prisma.nativeMemoryState.findUnique({
    where: { id: "default" },
    include: { embeddingSecret: true },
  });
  if (state?.status !== "connected") return null;
  const settings = settingsOf(state.configuration);
  if (!settings.embeddingModel || !settings.embeddingBaseUrl) return null;
  let apiKey = "local";
  if (state.embeddingSecret) {
    apiKey = await deps.secrets.load(state.embeddingSecret.ciphertext, state.embeddingSecret.id);
  }
  return {
    baseUrl: settings.embeddingBaseUrl,
    apiKey,
    model: settings.embeddingModel,
    ...(settings.embeddingDimensions ? { dimensions: settings.embeddingDimensions } : {}),
  };
}
