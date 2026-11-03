import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { HonchoModelSelection } from "@rakazo/adapters";
import {
  createHonchoConclusions,
  deleteHonchoConclusion,
  findConnectedModelCredential,
  honchoEmbeddingEnvironment,
  honchoValidationErrorMessage,
  honchoWorkspaceId,
  listHonchoConclusions,
  listHonchoPeers,
  queryHonchoConclusions,
  resolveHonchoModel,
  resolveMemberMainModel,
  validateManagedHonchoModels,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { type Prisma, runAsSystem } from "@rakazo/db";

export const MANAGED_HONCHO_VERSION = "3.5.0";
const LEASE_MS = 60_000;

export interface ManagedHonchoSettings {
  modelMode?: "main" | "fixed";
  credentialId?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingDimensions?: number;
  deriverWorkers?: number;
}

export interface ManagedHonchoDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
  supervisorUrl?: string;
  supervisorToken?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function settingsJson(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function componentJson(value: unknown): Record<string, boolean> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const component = object(entry);
        return [String(component.name), component.running === true];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(object(value)).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

function managedHonchoEnabled() {
  return process.env.HONCHO_MANAGED === "true" && Boolean(process.env.HONCHO_ADMIN_TOKEN);
}

export function managedHonchoDeps(deps: ManagedHonchoDeps): ManagedHonchoDeps {
  return {
    ...deps,
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL,
    supervisorToken: process.env.SANDBOX_SUPERVISOR_TOKEN,
  };
}

function supervisorRequest(deps: ManagedHonchoDeps, path: string, body: unknown) {
  if (!deps.supervisorUrl || !deps.supervisorToken) {
    throw new Error("Honcho supervisor is not configured");
  }
  return fetch(`${deps.supervisorUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.supervisorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
}

async function isDefaultSpaceOwner(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true, space: { select: { isDefault: true } } },
  });
  if (!member?.role.split(",").includes("owner")) return false;
  // A source-checkout feature database keeps its personal Space flag but may share
  // the deployment's original Space id. Treat either personal Space as the same owner.
  const owner = await prisma.spaceMember.findFirst({
    where: { userId: actor.userId, space: { isDefault: true }, role: { contains: "owner" } },
    select: { id: true },
  });
  return Boolean(member.space.isDefault || owner);
}

async function requireDefaultSpaceOwner(prisma: PrismaClient, actor: Actor) {
  if (!(await isDefaultSpaceOwner(prisma, actor))) {
    throw new Error("Only the personal Space owner can manage the shared Honcho service.");
  }
}

/** A managed config has no user-supplied endpoint or credential; the resolver uses the deployment's. */
export async function ensureManagedHonchoConfig(
  deps: Pick<ManagedHonchoDeps, "prisma"> & {
    secrets: Pick<SecretStore, "put"> & Partial<Pick<SecretStore, "load">>;
  },
  scope: { userId: string; spaceId: string },
) {
  if (!managedHonchoEnabled()) return { configured: false };
  return runAsSystem("initialize managed Honcho for a Space", async () => {
    const existing = await deps.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId: scope.spaceId },
    });
    if (existing) {
      return {
        configured: existing.provider === "honcho" && object(existing.settings).mode === "managed",
      };
    }
    await deps.prisma.honchoRuntimeState.upsert({
      where: { id: "default" },
      create: { version: MANAGED_HONCHO_VERSION },
      update: {},
    });
    const stored = await deps.secrets.put(JSON.stringify({ managed: true }), {
      operationId: "managed-honcho-space",
      traceId: "managed-honcho-space",
      spaceId: scope.spaceId,
      userId: scope.userId,
      signal: new AbortController().signal,
    });
    await deps.prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: scope.userId,
          spaceId: scope.spaceId,
          kind: "memory-provider",
          ciphertext: stored.ciphertext,
        },
      });
      await tx.spaceMemoryConfig.create({
        data: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          provider: "honcho",
          settings: { mode: "managed" },
          secretId: stored.id,
        },
      });
    });
    return { configured: true };
  });
}

export async function enableManagedHoncho(
  deps: Parameters<typeof ensureManagedHonchoConfig>[0],
  actor: Actor,
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  return ensureManagedHonchoConfig(deps, actor);
}

export async function readManagedHonchoState(deps: ManagedHonchoDeps, actor?: Actor) {
  const canManage = actor ? await isDefaultSpaceOwner(deps.prisma, actor) : false;
  const state = await runAsSystem("read managed Honcho status", () =>
    deps.prisma.honchoRuntimeState.findUnique({ where: { id: "default" } }),
  );
  const settings = settingsJson(state?.configuration);
  if (!state || !managedHonchoEnabled()) {
    return {
      enabled: managedHonchoEnabled(),
      canManage,
      status: "needs_configuration",
      version: MANAGED_HONCHO_VERSION,
      components: {},
      settings,
      error: managedHonchoEnabled()
        ? "Connect a main model and configure embeddings to start Honcho."
        : "Built-in Honcho is not enabled.",
    };
  }
  try {
    const response = await supervisorRequest(deps, "/honcho/status", {
      databaseUrl: process.env.HONCHO_DB_CONNECTION_URI,
      cacheUrl: process.env.HONCHO_CACHE_URL || "redis://127.0.0.1:6379/1?suppress=true",
      expectedConfigurationHash: state.configurationHash,
    });
    const status = object(await response.json());
    return {
      enabled: true,
      canManage,
      status: response.ok ? state.status : "degraded",
      version: state.version,
      components: componentJson(status.components ?? state.components),
      database: status.database === true,
      cache: status.cache === true,
      settings,
      error: response.ok ? state.error : "Honcho supervisor is unavailable.",
    };
  } catch {
    return {
      enabled: true,
      canManage,
      status: "degraded",
      version: state.version,
      components: componentJson(state.components),
      settings,
      error: "Honcho supervisor is unavailable.",
    };
  }
}

export async function markManagedHonchoForReconciliation(prisma: PrismaClient) {
  if (!managedHonchoEnabled()) return;
  await runAsSystem("model selection changed for managed Honcho", () =>
    prisma.honchoRuntimeState.updateMany({
      where: { id: "default" },
      data: { status: "pending", error: null },
    }),
  );
}

export async function updateManagedHonchoSettings(
  deps: ManagedHonchoDeps,
  actor: Actor,
  input: {
    modelMode?: "main" | "fixed";
    credentialId?: string;
    embeddingModel?: string;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    embeddingDimensions?: number;
    deriverWorkers?: number;
  },
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  const config = await deps.prisma.spaceMemoryConfig.findUnique({
    where: { spaceId: actor.spaceId },
  });
  if (config?.provider !== "honcho" || object(config.settings).mode !== "managed") {
    throw new Error("Enable built-in Honcho first.");
  }
  if (input.embeddingBaseUrl) {
    const url = URL.parse(input.embeddingBaseUrl);
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("Embedding base URL must be HTTP or HTTPS.");
    }
  }
  await runAsSystem("save managed Honcho settings", async () => {
    const runtime = await deps.prisma.honchoRuntimeState.findUnique({ where: { id: "default" } });
    if (!runtime) throw new Error("Enable built-in Honcho first.");
    const current = settingsJson(runtime.configuration);
    const modelMode = input.modelMode ?? current.modelMode ?? "main";
    const settings: Record<string, string> = {
      ...current,
      modelMode,
      ...(modelMode === "fixed" && input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.embeddingModel?.trim() ? { embeddingModel: input.embeddingModel.trim() } : {}),
      ...(input.embeddingBaseUrl !== undefined
        ? { embeddingBaseUrl: input.embeddingBaseUrl.trim() }
        : {}),
      ...(input.embeddingDimensions
        ? { embeddingDimensions: String(input.embeddingDimensions) }
        : {}),
      ...(input.deriverWorkers ? { deriverWorkers: String(input.deriverWorkers) } : {}),
    };
    if (modelMode === "main") delete settings.credentialId;
    if (modelMode === "fixed" && !settings.credentialId) {
      throw new Error("Choose a model connection.");
    }
    if (input.embeddingApiKey) {
      const stored = await deps.secrets.put(input.embeddingApiKey, {
        operationId: "managed-honcho-embedding",
        traceId: "managed-honcho-embedding",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      });
      await deps.prisma.$transaction(async (tx) => {
        await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "managed-honcho-embedding",
            ciphertext: stored.ciphertext,
          },
        });
        await tx.honchoRuntimeState.update({
          where: { id: "default" },
          data: { embeddingSecretId: stored.id },
        });
        if (runtime.embeddingSecretId) {
          await tx.secret.deleteMany({ where: { id: runtime.embeddingSecretId } });
        }
      });
    }
    await deps.prisma.honchoRuntimeState.update({
      where: { id: "default" },
      data: { configuration: settings, status: "pending", error: null },
    });
  });
}

function parseSettings(value: unknown): ManagedHonchoSettings {
  const settings = settingsJson(value);
  const positive = (key: string) => {
    if (!settings[key]) return undefined;
    const parsed = Number(settings[key]);
    if (!Number.isInteger(parsed) || parsed < 1)
      throw new Error(`${key} must be a positive integer`);
    return parsed;
  };
  return {
    modelMode: settings.modelMode === "fixed" ? "fixed" : "main",
    ...(settings.credentialId ? { credentialId: settings.credentialId } : {}),
    ...(settings.embeddingModel ? { embeddingModel: settings.embeddingModel } : {}),
    ...(settings.embeddingBaseUrl ? { embeddingBaseUrl: settings.embeddingBaseUrl } : {}),
    ...(settings.embeddingDimensions
      ? { embeddingDimensions: positive("embeddingDimensions") }
      : {}),
    ...(settings.deriverWorkers ? { deriverWorkers: positive("deriverWorkers") } : {}),
  };
}

export async function applyManagedHonchoForSpace(
  deps: ManagedHonchoDeps,
  actor: Actor,
  restart = false,
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  const config = await deps.prisma.spaceMemoryConfig.findUnique({
    where: { spaceId: actor.spaceId },
  });
  if (config?.provider !== "honcho" || object(config.settings).mode !== "managed") {
    throw new Error("Enable built-in Honcho first.");
  }
  const settings = await runAsSystem("read managed Honcho settings", async () =>
    parseSettings(
      (await deps.prisma.honchoRuntimeState.findUnique({ where: { id: "default" } }))
        ?.configuration,
    ),
  );
  let selected: HonchoModelSelection | undefined;
  if (settings.modelMode === "fixed" && settings.credentialId) {
    const credential = await findConnectedModelCredential(
      deps.prisma,
      deps.secrets,
      actor,
      "",
      undefined,
      { credentialId: settings.credentialId },
    );
    if (credential?.defaultModel) {
      selected = {
        credentialId: credential.id,
        provider: credential.provider,
        modelId: credential.defaultModel,
      };
    }
  } else {
    const main = await resolveMemberMainModel(
      { prisma: deps.prisma, secretStore: deps.secrets },
      actor,
    );
    if (main?.credential) {
      selected = {
        credentialId: main.credential.id,
        provider: main.provider || "",
        modelId: main.modelId || "",
      };
    }
  }
  if (!selected?.credentialId || !selected.provider || !selected.modelId) {
    throw new Error("Connect a compatible main model before starting Honcho.");
  }
  return reconcileManagedHoncho(deps, actor, selected, settings, restart);
}

async function reconcileManagedHoncho(
  deps: ManagedHonchoDeps,
  scope: { userId: string; spaceId: string },
  selected: HonchoModelSelection,
  settings: ManagedHonchoSettings,
  restart: boolean,
) {
  await runAsSystem("reconcile managed Honcho", async () => {
    const existing = await deps.prisma.honchoRuntimeState.findUnique({
      where: { id: "default" },
      include: { embeddingSecret: true },
    });
    if (!existing) throw new Error("Enable built-in Honcho first.");
    const now = new Date();
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > now) return;
    const owner = randomUUID();
    const lease = await deps.prisma.honchoRuntimeState.updateMany({
      where: { id: "default", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      data: {
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        status: "applying",
        error: null,
      },
    });
    if (!lease.count) return;
    const renewal = setInterval(() => {
      void deps.prisma.honchoRuntimeState
        .updateMany({
          where: { id: "default", leaseOwner: owner },
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
        .catch(() => undefined);
    }, LEASE_MS / 2);
    renewal.unref();
    try {
      if (!process.env.HONCHO_ADMIN_TOKEN)
        throw new Error("Honcho authentication is not configured.");
      const model = await resolveHonchoModel(deps, scope, selected);
      if (!model.ok) throw new Error(model.error);
      if (!settings.embeddingModel) {
        throw new Error("Configure an embedding model before starting Honcho.");
      }
      let embeddingApiKey: string | undefined;
      if (existing.embeddingSecret) {
        embeddingApiKey = await deps.secrets.load(
          existing.embeddingSecret.ciphertext,
          existing.embeddingSecret.id,
        );
      }
      const models: Record<string, string> = {
        ...model.env,
        ...honchoEmbeddingEnvironment({
          model: settings.embeddingModel,
          baseUrl: settings.embeddingBaseUrl,
          apiKey: embeddingApiKey,
          dimensions: settings.embeddingDimensions,
        }),
      };
      // Surface missing credentials as a setup step, not a provider failure:
      // the reconcile runs while the account has no model connection yet.
      const reasoningKey =
        models[models.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__API_KEY_ENV || "LLM_OPENAI_API_KEY"];
      if (!reasoningKey) throw new Error("Connect a model before starting Honcho.");
      if (!models.HONCHO_EMBEDDING_API_KEY || models.HONCHO_EMBEDDING_API_KEY === "local") {
        if (!models.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL) {
          throw new Error("Configure an embedding API key before starting Honcho.");
        }
      }
      const databaseUrl = process.env.HONCHO_DB_CONNECTION_URI;
      if (!databaseUrl) throw new Error("HONCHO_DB_CONNECTION_URI is not configured.");
      const honchoUrl = process.env.HONCHO_URL || "http://127.0.0.1:8000";
      const validationInput = () => ({
        reasoning: {
          model: models.LLM_UNIFIED_MODEL_CONFIG__MODEL || "",
          transport: models.LLM_UNIFIED_MODEL_CONFIG__TRANSPORT || "openai",
          apiKey:
            models[
              models.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__API_KEY_ENV || "LLM_OPENAI_API_KEY"
            ] || "",
          baseUrl: models.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__BASE_URL,
          ...(models.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS
            ? {
                providerParams: JSON.parse(
                  models.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS,
                ) as Record<string, unknown>,
              }
            : {}),
        },
        embedding: {
          model: models.EMBEDDING_MODEL_CONFIG__MODEL || "",
          apiKey: models.HONCHO_EMBEDDING_API_KEY || "",
          baseUrl: models.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL,
          dimensions: settings.embeddingDimensions ?? 1536,
        },
      });
      const response = await supervisorRequest(
        deps,
        restart ? "/honcho/restart" : "/honcho/apply",
        {
          databaseUrl,
          cacheUrl: process.env.HONCHO_CACHE_URL || "redis://127.0.0.1:6379/1?suppress=true",
          adminToken: process.env.HONCHO_ADMIN_TOKEN,
          models,
          deriverWorkers: settings.deriverWorkers ?? 1,
        },
      );
      const result = object(await response.json());
      if (!response.ok) throw new Error(String(result.error || "Honcho could not be configured"));
      // Probe once, after the containers run the configuration being applied.
      // Probing before the swap would only tell us what the previous
      // configuration did, and a bad configuration fails the swap's health
      // check anyway, so a second round trip buys nothing.
      const validation = await validateManagedHonchoModels(
        honchoUrl,
        process.env.HONCHO_ADMIN_TOKEN,
        validationInput(),
      );
      const validationError = honchoValidationErrorMessage(validation);
      if (validationError) throw new Error(validationError);
      await deps.prisma.honchoRuntimeState.update({
        where: { id: "default" },
        data: {
          status: "connected",
          configurationHash:
            typeof result.configurationHash === "string" ? result.configurationHash : null,
          components: (result.components ?? {}) as Prisma.InputJsonValue,
          error: null,
        },
      });
    } catch (error) {
      await deps.prisma.honchoRuntimeState.update({
        where: { id: "default" },
        data: {
          status: "degraded",
          error:
            error instanceof Error ? error.message.slice(0, 500) : "Honcho configuration failed",
        },
      });
    } finally {
      clearInterval(renewal);
      await deps.prisma.honchoRuntimeState.updateMany({
        where: { id: "default", leaseOwner: owner },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
    }
  });
  return readManagedHonchoState(deps);
}

/** The shared service follows the personal Space's model, never another tenant's credentials. */
export async function reconcileManagedHonchoForDeployment(deps: ManagedHonchoDeps) {
  if (!managedHonchoEnabled()) return;
  const actor = await runAsSystem("find managed Honcho owner", async () => {
    const space = await deps.prisma.space.findFirst({
      where: { isDefault: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!space) return null;
    const owner = await deps.prisma.spaceMember.findFirst({
      where: { spaceId: space.id, role: { contains: "owner" } },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    return owner ? { spaceId: space.id, userId: owner.userId } : null;
  });
  if (!actor) return;
  const state = await runAsSystem("check managed Honcho reconciliation", () =>
    deps.prisma.honchoRuntimeState.findUnique({ where: { id: "default" } }),
  );
  if (!state || !["pending", "degraded"].includes(state.status)) return;
  await applyManagedHonchoForSpace(deps, {
    ...actor,
    email: "",
    isDeploymentOwner: true,
  });
}

/**
 * The Honcho connection for browsing a Space's memory. The deployment's
 * static admin token can read every workspace; callers still resolve the
 * Space's own workspace so a member only ever sees their Space's conclusions.
 */
function managedHonchoConnection() {
  if (!managedHonchoEnabled()) return null;
  const adminToken = process.env.HONCHO_ADMIN_TOKEN;
  if (!adminToken) return null;
  return {
    baseUrl: process.env.HONCHO_URL || "http://127.0.0.1:8000",
    apiKey: adminToken,
    // Conclusions never invoke the dialectic; the field is part of the
    // client's connection type, not part of a browse call.
    reasoningLevel: "medium" as const,
  };
}

/** The Space's Honcho workspace, resolved from its memory-provider settings. */
async function managedHonchoWorkspaceId(
  deps: Pick<ManagedHonchoDeps, "prisma">,
  spaceId: string,
): Promise<string | null> {
  const config = await runAsSystem("read memory config for Honcho browse", () =>
    deps.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId },
      select: { provider: true, settings: true },
    }),
  );
  if (config?.provider !== "honcho") return null;
  return honchoWorkspaceId(settingsJson(config.settings), spaceId);
}

function honchoBrowseError(error: unknown): never {
  throw new Error(
    error instanceof Error ? error.message.slice(0, 300) : "Honcho memory is unavailable",
  );
}

export async function listManagedHonchoMemory(
  deps: Pick<ManagedHonchoDeps, "prisma">,
  actor: Actor,
  input: {
    query?: string;
    observerId?: string;
    observedId?: string;
    page?: number;
    size?: number;
  },
) {
  const honcho = managedHonchoConnection();
  const workspaceId = honcho ? await managedHonchoWorkspaceId(deps, actor.spaceId) : null;
  if (!honcho || !workspaceId) {
    return { items: [], page: input.page ?? 1, size: input.size ?? 50 };
  }
  const page = input.page ?? 1;
  const size = input.size ?? 50;
  if (input.query) {
    if (!input.observerId || !input.observedId) {
      throw new Error("Semantic memory search needs an observer and an observed peer.");
    }
    const result = await queryHonchoConclusions(honcho, workspaceId, {
      query: input.query,
      observerId: input.observerId,
      observedId: input.observedId,
      topK: size,
    }).catch(honchoBrowseError);
    if (!result.ok) honchoBrowseError(result.error);
    return { items: result.value, page, size };
  }
  const result = await listHonchoConclusions(honcho, workspaceId, { page, size }).catch(
    honchoBrowseError,
  );
  if (!result.ok) honchoBrowseError(result.error);
  return { items: result.value, page, size };
}

export async function listManagedHonchoMemoryPeers(
  deps: Pick<ManagedHonchoDeps, "prisma">,
  actor: Actor,
) {
  const honcho = managedHonchoConnection();
  const workspaceId = honcho ? await managedHonchoWorkspaceId(deps, actor.spaceId) : null;
  if (!honcho || !workspaceId) return { items: [] };
  const result = await listHonchoPeers(honcho, workspaceId).catch(honchoBrowseError);
  if (!result.ok) honchoBrowseError(result.error);
  return { items: result.value };
}

export async function createManagedHonchoMemory(
  deps: Pick<ManagedHonchoDeps, "prisma">,
  actor: Actor,
  input: { content: string; observerId: string; observedId: string },
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  const honcho = managedHonchoConnection();
  const workspaceId = honcho ? await managedHonchoWorkspaceId(deps, actor.spaceId) : null;
  if (!honcho || !workspaceId) {
    throw new Error("Built-in Honcho is not enabled.");
  }
  const result = await createHonchoConclusions(honcho, workspaceId, [
    {
      content: input.content,
      observerId: input.observerId,
      observedId: input.observedId,
    },
  ]).catch(honchoBrowseError);
  if (!result.ok) honchoBrowseError(result.error);
  return { ok: true as const };
}

export async function deleteManagedHonchoMemory(
  deps: Pick<ManagedHonchoDeps, "prisma">,
  actor: Actor,
  input: { conclusionId: string },
) {
  await requireDefaultSpaceOwner(deps.prisma, actor);
  const honcho = managedHonchoConnection();
  const workspaceId = honcho ? await managedHonchoWorkspaceId(deps, actor.spaceId) : null;
  if (!honcho || !workspaceId) {
    throw new Error("Built-in Honcho is not enabled.");
  }
  const result = await deleteHonchoConclusion(honcho, workspaceId, input.conclusionId).catch(
    honchoBrowseError,
  );
  if (!result.ok) honchoBrowseError(result.error);
  return { ok: true as const };
}
