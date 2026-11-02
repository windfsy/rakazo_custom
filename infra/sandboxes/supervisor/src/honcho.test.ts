import { describe, expect, it } from "vitest";
import { honchoEnvironment } from "./honcho.js";

describe("managed Honcho service", () => {
  it("enables authentication, PostgreSQL vectors and an isolated Redis namespace", () => {
    const env = honchoEnvironment({
      databaseUrl: "postgresql+psycopg://honcho:password@localhost/honcho",
      cacheUrl: "redis://localhost:6379/1",
      adminToken: "a".repeat(32),
      models: { LLM_OPENAI_API_KEY: "test-key" },
      deriverWorkers: 1,
    });
    expect(env.AUTH_USE_AUTH).toBe("true");
    expect(env.AUTH_STATIC_ADMIN_TOKEN).toBe("a".repeat(32));
    expect(env.AUTH_JWT_SECRET).toBeUndefined();
    // The API process runs the deriver queue loop; no second container.
    expect(env.DERIVER_EMBEDDED).toBe("true");
    expect(env.VECTOR_STORE_TYPE).toBe("pgvector");
    expect(env.CACHE_NAMESPACE).toBe("rakazo");
    expect(env.LLM_OPENAI_API_KEY).toBe("test-key");
    expect(env.TELEMETRY_ENABLED).toBe("false");
  });
});
