import type { DurableMemoryScope, SecretStore, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createNativeProvider, NATIVE_PROVIDER_ID } from "./memory-native/index.js";
import type { MemoryRerankDeps } from "./memory-native/rerank.js";
import {
  createHonchoProvider,
  HONCHO_PROVIDER_ID,
  honchoRequiresPrivateEndpoint,
  prepareHonchoConnection,
} from "./honcho-memory-provider.js";
import { revalidateLocalServiceSettings } from "./local-service-endpoint.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  SERENITY_PROVIDER_ID,
  serenityRequiresPrivateEndpoint,
} from "./serenity-memory-provider.js";

export { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

import {
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_PROVIDER_ID,
  supermemoryRequiresPrivateEndpoint,
} from "./supermemory-memory-provider.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** When false, providers must not probe endpoints that classify as private. */
  allowPrivateEndpoint?: boolean;
}

export interface PreparedMemoryProviderConnection {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface ConfiguredMemoryProvider {
  provider: SemanticMemoryProvider;
  defaultScope: DurableMemoryScope;
}

export interface MemoryProviderResolver {
  resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null>;
}

interface MemoryProviderAdapter {
  requiresPrivateEndpoint(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
  /** Recheck persisted endpoint settings before their credentials are decrypted. */
  revalidate?(settings: Record<string, string>): Promise<void>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options?: { allowPrivateEndpoint?: boolean },
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ): SemanticMemoryProvider;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map([
  [
    SUPERMEMORY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: supermemoryRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareSupermemoryConnection,
      create: createSupermemoryProvider,
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
  [
    SERENITY_PROVIDER_ID,
    {
      requiresPrivateEndpoint: serenityRequiresPrivateEndpoint,
      classifySettings: classifySerenityConnectionSettings,
      prepare: (
        settings: Record<string, string>,
        credentials: Record<string, string>,
        options?: { allowPrivateEndpoint?: boolean },
      ) => prepareSerenityConnection(settings, credentials, undefined, options),
      create: createSerenityProvider,
    },
  ],
  [
    HONCHO_PROVIDER_ID,
    {
      requiresPrivateEndpoint: honchoRequiresPrivateEndpoint,
      revalidate: revalidateLocalServiceSettings,
      prepare: prepareHonchoConnection,
      create: createHonchoProvider,
    },
  ],
  [
    NATIVE_PROVIDER_ID,
    {
      requiresPrivateEndpoint: () => false,
      prepare: async (settings: Record<string, string>) => ({ settings, credentials: {} }),
      // The native provider is constructed from database access, not credentials:
      // SpaceMemoryProviderResolver supplies the PrismaClient when it resolves.
      create: () => {
        throw new Error("The native provider is constructed by SpaceMemoryProviderResolver.");
      },
    },
  ] satisfies [string, MemoryProviderAdapter],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresPrivateEndpoint(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresPrivateEndpoint(settings);
}

/**
 * Run provider-specific trust classification (DNS, etc.) without credentialed probes.
 * Callers must authorize private endpoints through operator configuration before prepare/probe.
 */
export async function classifyMemoryProviderSettings(
  provider: string,
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const adapter = memoryProviderAdapter(provider);
  return adapter.classifySettings ? adapter.classifySettings(settings) : settings;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
): Promise<PreparedMemoryProviderConnection> {
  const prepared = await memoryProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
    { allowPrivateEndpoint: input.allowPrivateEndpoint },
  );
  return { provider: input.provider, ...prepared };
}

export function createMemoryProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return memoryProviderAdapter(provider).create(settings, credentials);
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeCredentials(provider: string, plaintext: string): Record<string, string> {
  try {
    const credentials = toStringRecord(JSON.parse(plaintext));
    if (Object.keys(credentials).length > 0) return credentials;
  } catch {
    // Configurations created before the generic provider boundary stored the API key directly.
  }
  const legacyCredentials = memoryProviderAdapter(provider).decodeLegacyCredentials?.(plaintext);
  if (legacyCredentials) return legacyCredentials;
  throw new Error(`Stored credentials for memory provider "${provider}" are invalid.`);
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceMemoryConfig"> & PrismaClient,
    private readonly secrets: SecretStore,
    /** Supplied by the worker, where recall runs; the API browser keeps the fused order. */
    private readonly nativeRerank?: MemoryRerankDeps,
  ) {}

  async resolve(spaceId: string): Promise<ConfiguredMemoryProvider | null> {
    const config = await this.prisma.spaceMemoryConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config) return null;
    const settings = toStringRecord(config.settings);
    if (config.provider === NATIVE_PROVIDER_ID) {
      return {
        provider: createNativeProvider({
          prisma: this.prisma,
          secrets: this.secrets,
          ...(this.nativeRerank ? { rerank: this.nativeRerank } : {}),
        }),
        defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
      };
    }
    if (memoryProviderRequiresPrivateEndpoint(config.provider, settings)) {
      // Saved configurations cannot bypass an operator's current network policy.
      if (process.env.MCP_ALLOW_PRIVATE_ENDPOINT !== "true") return null;
    }
    const adapter = memoryProviderAdapter(config.provider);
    try {
      await adapter.revalidate?.(settings);
    } catch {
      getLogger().warn("Semantic memory disabled: endpoint revalidation failed");
      return null;
    }
    const credentials = decodeCredentials(
      config.provider,
      await this.secrets.load(config.secret.ciphertext, config.secret.id),
    );
    return {
      provider: createMemoryProvider(config.provider, settings, credentials),
      defaultScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    };
  }
}
