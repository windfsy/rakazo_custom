import { describe, expect, it } from "vitest";
import { apiKeyHint, readNativeMemoryState } from "./state.js";

describe("apiKeyHint", () => {
  it("shows the last six characters so a member can tell keys apart", () => {
    expect(apiKeyHint("sk-proj-abcdef123456")).toBe("…123456");
  });

  it("never returns the whole key, even a short one", () => {
    expect(apiKeyHint("short")).toBe("…");
    expect(apiKeyHint("sk-1234")).toBe("…");
  });

  it("ignores surrounding whitespace", () => {
    expect(apiKeyHint("  sk-proj-abcdef123456  ")).toBe("…123456");
  });
});

describe("readNativeMemoryState", () => {
  it("reports needs_configuration before anything is set", async () => {
    const prisma = { nativeMemoryState: { findUnique: async () => null } };
    const state = await readNativeMemoryState(prisma as never);
    expect(state).toEqual({ status: "needs_configuration", settings: {}, error: null });
  });

  it("returns the stored model, dimensions and key hint", async () => {
    const prisma = {
      nativeMemoryState: {
        findUnique: async () => ({
          status: "connected",
          error: null,
          configuration: {
            embeddingModel: "text-embedding-3-small",
            embeddingBaseUrl: "https://api.openai.com/v1",
            embeddingDimensions: 1536,
            embeddingApiKeyHint: "…123456",
          },
        }),
      },
    };
    const state = await readNativeMemoryState(prisma as never);
    expect(state.settings.embeddingApiKeyHint).toBe("…123456");
    expect(state.settings.embeddingDimensions).toBe(1536);
  });
});
