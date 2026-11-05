import { getLogger } from "@rakazo/logging";
import { assertAllowedOpenAiCompatibleUrl } from "../openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "../pi-openai-compatible-provider.js";

const EMBED_TIMEOUT_MS = 30_000;
/** pgvector's HNSW expression index tops out at 2000 dimensions; recall stays well under it. */
export const MAX_EMBEDDING_DIMENSIONS = 2000;
/** One request's input strings; batched to keep a single embedding call small. */
const MAX_BATCH_INPUTS = 64;
/** OpenAI-compatible endpoints reject inputs beyond this many tokens; truncate before sending. */
const MAX_INPUT_CHARS = 24_000;

export interface EmbeddingConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional per-request `dimensions`; omitted when the endpoint rejects the parameter. */
  dimensions?: number;
  headers?: Record<string, string>;
}

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] | string }>;
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** pgvector accepts the text form of a vector everywhere a vector value goes. */
export function embeddingToVectorLiteral(embedding: number[]): string {
  return vectorLiteral(embedding);
}

function parseEmbedding(value: number[] | string): number[] {
  if (Array.isArray(value)) return value.map((n) => Number(n));
  // Some gateways return base64-packed floats; the JSON array form is the common path.
  throw new Error("The embedding endpoint returned a non-JSON embedding payload.");
}

function truncateUtf8(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

/**
 * Calls an OpenAI-compatible `POST {baseUrl}/embeddings`. The endpoint is guarded by the
 * same URL policy as model connections: private networks need the operator's opt-in, and
 * a keyed request must be HTTPS.
 */
export class EmbeddingClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly connection: EmbeddingConnection,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.fetchImpl =
      fetchImpl ??
      createOpenAiCompatibleFetch(undefined, undefined, { headers: connection.headers });
  }

  private async request(input: string[]): Promise<number[][]> {
    const base = this.connection.baseUrl.replace(/\/+$/, "");
    const url = assertAllowedOpenAiCompatibleUrl(`${base}/embeddings`);
    const body: Record<string, unknown> = {
      model: this.connection.model,
      input: input.map((text) => truncateUtf8(text, MAX_INPUT_CHARS)),
    };
    if (this.connection.dimensions) body.dimensions = this.connection.dimensions;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.connection.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `The embedding endpoint failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as EmbeddingsResponse;
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error("The embedding endpoint returned an unexpected payload.");
    }
    // Restore request order: some endpoints sort by index.
    const ordered: Array<number[] | undefined> = new Array(input.length);
    for (const item of data) {
      const index = typeof item.index === "number" ? item.index : data.indexOf(item);
      if (index < 0 || index >= input.length) {
        throw new Error("The embedding endpoint returned an out-of-range index.");
      }
      if (item.embedding === undefined) {
        throw new Error("The embedding endpoint returned an item without an embedding.");
      }
      ordered[index] = parseEmbedding(item.embedding);
    }
    const embeddings = ordered.map((embedding) => {
      if (!embedding) throw new Error("The embedding endpoint returned an incomplete batch.");
      if (embedding.length === 0)
        throw new Error("The embedding endpoint returned an empty vector.");
      if (embedding.length > MAX_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `The embedding model returns ${embedding.length} dimensions, above the ${MAX_EMBEDDING_DIMENSIONS} this store supports.`,
        );
      }
      return embedding;
    });
    return embeddings;
  }

  /** Embeds one text; throws on any endpoint failure. */
  async embed(text: string): Promise<EmbeddingResult> {
    const [embedding] = await this.request([text]);
    return { embedding: embedding!, dimensions: embedding!.length };
  }

  /** Embeds a batch, splitting into endpoint-sized requests. */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_INPUTS) {
      const batch = texts.slice(i, i + MAX_BATCH_INPUTS);
      for (const embedding of await this.request(batch)) {
        results.push({ embedding, dimensions: embedding.length });
      }
    }
    return results;
  }
}

/** Probes an embedding configuration the way recall and ingestion will use it. */
export async function probeEmbeddingConnection(
  connection: EmbeddingConnection,
  fetchImpl?: typeof globalThis.fetch,
): Promise<{ ok: true; dimensions: number } | { ok: false; error: string }> {
  try {
    const client = new EmbeddingClient(connection, fetchImpl);
    const result = await client.embed("connection probe");
    if (connection.dimensions && connection.dimensions !== result.dimensions) {
      return {
        ok: false,
        error: `The embedding model returned ${result.dimensions} dimensions, not the configured ${connection.dimensions}.`,
      };
    }
    return { ok: true, dimensions: result.dimensions };
  } catch (error) {
    getLogger().warn("native memory embedding probe failed", { error });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
