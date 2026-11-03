import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HONCHO_EMBEDDING_MAX_DIMENSIONS,
  honchoEmbeddingEnvironment,
  honchoModelEnvironment,
} from "./honcho-managed.js";

describe("managed Honcho configuration", () => {
  it("emits one unified model env group instead of per-feature fan-out", () => {
    const env = honchoModelEnvironment({
      transport: "openai",
      model: "deepseek-v4.1-flash",
      baseUrl: "https://opencode.ai/inference/go/v1",
      apiKeyEnv: "LLM_OPENAI_API_KEY",
      apiKey: "test-key",
    });
    expect(env.LLM_UNIFIED_MODEL_CONFIG__MODEL).toBe("deepseek-v4.1-flash");
    expect(env.LLM_UNIFIED_MODEL_CONFIG__TRANSPORT).toBe("openai");
    expect(env.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__BASE_URL).toBe(
      "https://opencode.ai/inference/go/v1",
    );
    expect(env.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__API_KEY_ENV).toBe("LLM_OPENAI_API_KEY");
    expect(env.LLM_OPENAI_API_KEY).toBe("test-key");
    expect(Object.keys(env).filter((key) => key.startsWith("DERIVER_"))).toEqual([]);
    expect(Object.keys(env).filter((key) => key.startsWith("DIALECTIC_"))).toEqual([]);
  });

  it("passes custom model headers through provider_params", () => {
    const env = honchoModelEnvironment({
      transport: "openai",
      model: "my-model",
      apiKeyEnv: "LLM_OPENAI_API_KEY",
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1234/v1",
      headers: { "x-custom-header": "value" },
    });
    expect(env.LLM_UNIFIED_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS).toBe(
      JSON.stringify({ extra_headers: { "x-custom-header": "value" } }),
    );
  });

  it("keeps embeddings independently configurable", () => {
    const env = honchoEmbeddingEnvironment({
      model: "text-embedding-3-small",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "embedding-key",
      dimensions: 1536,
    });
    expect(env.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL).toBe("http://127.0.0.1:1234/v1");
    expect(env.EMBEDDING_VECTOR_DIMENSIONS).toBe("1536");
    expect(env.HONCHO_EMBEDDING_API_KEY).toBe("embedding-key");
    expect("LLM_OPENAI_API_KEY" in env).toBe(false);
  });

  it("rejects embedding dimensions beyond the pgvector HNSW limit", () => {
    expect(() => honchoEmbeddingEnvironment({ model: "embedding-3", dimensions: 2048 })).toThrow(
      /2000/,
    );
    expect(HONCHO_EMBEDDING_MAX_DIMENSIONS).toBe(2000);
    expect(() =>
      honchoEmbeddingEnvironment({ model: "embedding-3", dimensions: 1536 }),
    ).not.toThrow();
  });

  it("tracks the vendored Honcho version", () => {
    const pyproject = readFileSync(
      resolve(import.meta.dirname, "../../../infra/honcho/pyproject.toml"),
      "utf8",
    );
    const version = /^version = "(.+)"$/m.exec(pyproject)?.[1];
    expect(version).toBe("3.5.0");
  });
});
