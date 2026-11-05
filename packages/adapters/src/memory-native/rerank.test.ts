import { describe, expect, it } from "vitest";
import { parseMemoryJson } from "./llm.js";
import { rerankFacts } from "./rerank.js";
import type { NativeFact } from "./store.js";

function fact(id: string, content: string): NativeFact {
  return {
    id,
    botId: "bot",
    level: "explicit",
    status: "active",
    content,
    occurredAt: null,
    createdAt: new Date(0),
  };
}

function runtimeAnswering(text: string) {
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {} as never,
    }),
    async *run() {
      yield { type: "done", text } as never;
    },
    async abort() {},
  };
}

const scope = { spaceId: "s", userId: "u", botId: "b" };
const model = { provider: "fake", id: "fake" };

describe("rerankFacts", () => {
  const facts = [fact("a", "first"), fact("b", "second"), fact("c", "third")];

  it("returns the fused order for a single fact without calling the model", async () => {
    const [only] = await rerankFacts(
      { runtime: runtimeAnswering("no"), resolveModel: async () => model },
      { query: "q", facts: [facts[0]!], scope },
    );
    expect(only).toBe(facts[0]);
  });

  it("reorders by the model's ids", async () => {
    const ordered = await rerankFacts(
      {
        runtime: runtimeAnswering(JSON.stringify({ relevantIds: ["c", "a"] })),
        resolveModel: async () => model,
      },
      { query: "q", facts, scope },
    );
    expect(ordered.map((item) => item.id)).toEqual(["c", "a"]);
  });

  it("drops ids the model invented", async () => {
    const ordered = await rerankFacts(
      {
        runtime: runtimeAnswering(JSON.stringify({ relevantIds: ["ghost", "b"] })),
        resolveModel: async () => model,
      },
      { query: "q", facts, scope },
    );
    expect(ordered.map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps the fused order when the model returns nothing usable", async () => {
    for (const text of ['{"relevantIds":[]}', "not json", '{"wrong":[]}']) {
      const ordered = await rerankFacts(
        { runtime: runtimeAnswering(text), resolveModel: async () => model },
        { query: "q", facts, scope },
      );
      expect(ordered).toEqual(facts);
    }
  });

  it("keeps the fused order when model resolution fails", async () => {
    const ordered = await rerankFacts(
      {
        runtime: runtimeAnswering("{}"),
        resolveModel: async () => {
          throw new Error("no model");
        },
      },
      { query: "q", facts, scope },
    );
    expect(ordered).toEqual(facts);
  });

  it("keeps the fused order for the scripted runtime", async () => {
    const ordered = await rerankFacts(
      {
        runtime: runtimeAnswering("{}"),
        resolveModel: async () => ({ provider: "scripted", id: "scripted" }),
      },
      { query: "q", facts, scope },
    );
    expect(ordered).toEqual(facts);
  });
});

describe("parseMemoryJson object shape used by consolidation", () => {
  it("reads supersede and expire arrays", () => {
    const parsed = parseMemoryJson(
      JSON.stringify({
        superseded: [{ olderIds: ["a"], newerId: "b", reason: "moved" }],
        expired: [{ ids: ["c"], reason: "past event" }],
      }),
    );
    expect(parsed.ok).toBe(true);
  });
});
