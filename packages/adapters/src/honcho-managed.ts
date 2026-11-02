import { createHash } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SecretStore } from "@rakazo/adapter-kit";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findConnectedModelCredential, loadStoredModelSecret } from "./model-selection.js";
import { parseModelSecret } from "./pi-oauth.js";

export type HonchoModelSelection = {
  provider: string;
  modelId: string;
  credentialId: string;
};

export type HonchoModelConfiguration = {
  transport: "openai" | "anthropic" | "gemini";
  model: string;
  baseUrl?: string;
  apiKeyEnv: "LLM_OPENAI_API_KEY" | "LLM_ANTHROPIC_API_KEY" | "LLM_GEMINI_API_KEY";
  apiKey: string;
  headers?: Record<string, string>;
};

export type HonchoConfigurationResult =
  | { ok: true; env: Record<string, string>; summary: { provider: string; modelId: string } }
  | { ok: false; error: string };

const transports: Record<string, HonchoModelConfiguration["transport"]> = {
  openai: "openai",
  "azure-openai-responses": "openai",
  openrouter: "openai",
  "openai-compatible": "openai",
  opencode: "openai",
  "opencode-go": "openai",
  anthropic: "anthropic",
  "google-generative-ai": "gemini",
  "google-vertex": "gemini",
};

const keyEnvs: Record<
  HonchoModelConfiguration["transport"],
  HonchoModelConfiguration["apiKeyEnv"]
> = {
  openai: "LLM_OPENAI_API_KEY",
  anthropic: "LLM_ANTHROPIC_API_KEY",
  gemini: "LLM_GEMINI_API_KEY",
};

export function honchoModelEnvironment(config: HonchoModelConfiguration): Record<string, string> {
  // Honcho fills the unified model into every reasoning feature that is not
  // explicitly configured (LLM_UNIFIED_MODEL_CONFIG, a Rakazo-side addition),
  // so one group of env vars replaces the former per-feature fan-out.
  const providerParams: Record<string, unknown> = {};
  if (config.headers && Object.keys(config.headers).length > 0) {
    providerParams.extra_headers = config.headers;
  }
  return {
    [config.apiKeyEnv]: config.apiKey,
    LLM_UNIFIED_MODEL_CONFIG__TRANSPORT: config.transport,
    LLM_UNIFIED_MODEL_CONFIG__MODEL: config.model,
    LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__API_KEY_ENV: config.apiKeyEnv,
    ...(config.baseUrl ? { LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__BASE_URL: config.baseUrl } : {}),
    ...(Object.keys(providerParams).length > 0
      ? {
          LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS: JSON.stringify(providerParams),
        }
      : {}),
  };
}

export async function resolveHonchoModel(
  deps: { prisma: PrismaClient; secrets: Pick<SecretStore, "load"> },
  scope: { userId: string; spaceId: string },
  selection?: HonchoModelSelection,
): Promise<HonchoConfigurationResult> {
  if (!selection) return { ok: false, error: "Connect a main model before enabling Honcho." };
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secrets,
    scope,
    selection.provider,
    selection.modelId,
    { credentialId: selection.credentialId },
  );
  if (!credential) return { ok: false, error: "The selected model connection is unavailable." };
  const stored = await loadStoredModelSecret(
    deps.prisma,
    deps.secrets,
    scope.userId,
    credential.secretId,
  );
  if (stored.status !== "loaded")
    return { ok: false, error: "The selected model credential is unavailable." };
  const secret = parseModelSecret(stored.plaintext);
  if (secret.kind === "oauth") {
    return { ok: false, error: "Honcho needs an API key or OpenAI-compatible model connection." };
  }
  const transport = transports[canonicalPiProviderId(selection.provider)];
  if (!transport) {
    return { ok: false, error: `${selection.provider} is not supported by Honcho.` };
  }
  let apiKey: string;
  let baseUrl: string | undefined;
  let headers: Record<string, string> | undefined;
  if (secret.kind === "openai_compatible") {
    if (transport !== "openai")
      return { ok: false, error: "This model cannot use Honcho's OpenAI transport." };
    if (secret.apiProtocol && secret.apiProtocol !== "chat-completions") {
      return { ok: false, error: "Honcho requires an OpenAI chat-completions model endpoint." };
    }
    apiKey = secret.apiKey || "local";
    baseUrl = secret.baseUrl;
    headers = secret.headers;
  } else {
    apiKey = secret.key;
  }
  if (!baseUrl && transport === "openai") {
    const model = builtinModels()
      .getModels()
      .find((entry) => entry.provider === selection.provider && entry.id === selection.modelId);
    baseUrl = model?.baseUrl;
  }
  if (!baseUrl && selection.provider === "openrouter") baseUrl = "https://openrouter.ai/api/v1";
  return {
    ok: true,
    env: honchoModelEnvironment({
      transport,
      model: selection.modelId,
      ...(baseUrl ? { baseUrl } : {}),
      apiKeyEnv: keyEnvs[transport],
      apiKey,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    }),
    summary: { provider: selection.provider, modelId: selection.modelId },
  };
}

/** pgvector's HNSW index cannot exceed 2000 dimensions. */
export const HONCHO_EMBEDDING_MAX_DIMENSIONS = 2000;

export function honchoEmbeddingEnvironment(input: {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
}) {
  return {
    HONCHO_EMBEDDING_API_KEY: input.apiKey || "local",
    ...honchoEmbeddingModelEnvironment(input),
  };
}

function honchoEmbeddingModelEnvironment(input: {
  model: string;
  baseUrl?: string;
  dimensions?: number;
}) {
  const model = input.model.trim();
  if (!model) throw new Error("An embedding model is required.");
  const dimensions = input.dimensions ?? 1536;
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > HONCHO_EMBEDDING_MAX_DIMENSIONS
  ) {
    throw new Error(
      `Embedding dimensions must be an integer between 1 and ${HONCHO_EMBEDDING_MAX_DIMENSIONS}.`,
    );
  }
  return {
    EMBEDDING_MODEL_CONFIG__TRANSPORT: "openai",
    EMBEDDING_MODEL_CONFIG__MODEL: model,
    EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV: "HONCHO_EMBEDDING_API_KEY",
    ...(input.baseUrl?.trim()
      ? { EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL: input.baseUrl.trim() }
      : {}),
    EMBEDDING_VECTOR_DIMENSIONS: String(dimensions),
  };
}

export type HonchoModelValidationInput = {
  reasoning: {
    model: string;
    transport: string;
    apiKey: string;
    baseUrl?: string;
    providerParams?: Record<string, unknown>;
  };
  embedding: {
    model: string;
    apiKey: string;
    baseUrl?: string;
    dimensions: number;
  };
};

export type HonchoModelValidationResult = {
  reasoning?: { ok: boolean; detail?: string };
  embedding?: { ok: boolean; detail?: string };
};

/**
 * Ask the running Honcho API to validate the model configuration through its
 * real backend/embedding-client code paths (`POST /admin/validate_models`,
 * a Rakazo-side addition). Probing in-container keeps headers, proxies and
 * protocol handling identical to the workloads being validated.
 */
export async function validateManagedHonchoModels(
  honchoUrl: string,
  adminToken: string,
  input: HonchoModelValidationInput,
): Promise<HonchoModelValidationResult> {
  const response = await fetch(`${honchoUrl.replace(/\/$/, "")}/admin/validate_models`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    return {
      reasoning: {
        ok: false,
        detail: `Honcho validation endpoint failed (${response.status}).`,
      },
    };
  }
  return (await response.json()) as HonchoModelValidationResult;
}

export function honchoValidationErrorMessage(result: HonchoModelValidationResult): string {
  const parts: string[] = [];
  if (result.reasoning && !result.reasoning.ok) {
    parts.push(`Reasoning model check failed${result.reasoning.detail ? `: ${result.reasoning.detail}` : ""}`);
  }
  if (result.embedding && !result.embedding.ok) {
    parts.push(`Embedding model check failed${result.embedding.detail ? `: ${result.embedding.detail}` : ""}`);
  }
  return parts.join("; ");
}

export function honchoConfigurationHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
