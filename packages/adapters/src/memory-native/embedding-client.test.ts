import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingClient,
  embeddingToVectorLiteral,
  MAX_EMBEDDING_DIMENSIONS,
} from "./embedding-client.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof EmbeddingClient>[0]> = {},
) {
  return new EmbeddingClient(
    { baseUrl: "https://embed.example.com/v1", apiKey: "sk-test", model: "embed-v1", ...overrides },
    fetchImpl as typeof globalThis.fetch,
  );
}

describe("EmbeddingClient", () => {
  it("embeds one text and reports its dimensions", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    );
    const result = await client(fetchImpl).embed("hello");
    expect(result).toEqual({ embedding: [0.1, 0.2, 0.3], dimensions: 3 });
  });

  it("restores request order when the endpoint sorts by index", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0.4, 0.5] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    );
    const [first, second] = await client(fetchImpl).embedBatch(["a", "b"]);
    expect(first!.embedding).toEqual([0.1, 0.2]);
    expect(second!.embedding).toEqual([0.4, 0.5]);
  });

  it("sends the configured model and dimensions", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ data: [{ index: 0, embedding: [0.1] }] }),
    );
    await new EmbeddingClient(
      {
        baseUrl: "https://embed.example.com/v1",
        apiKey: "sk-test",
        model: "embed-v1",
        dimensions: 512,
      },
      fetchImpl as typeof globalThis.fetch,
    ).embed("hello");
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse((init?.body ?? "{}") as string);
    expect(body.model).toBe("embed-v1");
    expect(body.dimensions).toBe(512);
  });

  it("surfaces endpoint errors with status and body detail", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(client(fetchImpl).embed("hello")).rejects.toThrow(/401/);
  });

  it("rejects an empty or oversized vector", async () => {
    const empty = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [] }] }));
    await expect(client(empty).embed("hello")).rejects.toThrow(/empty vector/);
    const big = Array.from({ length: MAX_EMBEDDING_DIMENSIONS + 1 }, (_, i) => i);
    const oversized = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: big }] }));
    await expect(client(oversized).embed("hello")).rejects.toThrow(/above the/);
  });

  it("rejects a batch whose response is incomplete", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [0.1] }] }));
    await expect(client(fetchImpl).embedBatch(["a", "b"])).rejects.toThrow(/unexpected payload/);
  });

  it("renders a vector literal pgvector accepts", () => {
    expect(embeddingToVectorLiteral([0.5, -0.25, 0])).toBe("[0.5,-0.25,0]");
  });
});
