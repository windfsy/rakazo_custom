import { describe, expect, it, vi } from "vitest";
import { isValidExtractedFact } from "./extract.js";
import { parseMemoryJson } from "./llm.js";

describe("parseMemoryJson", () => {
  it("reads a bare JSON object", () => {
    const parsed = parseMemoryJson('{"facts":[]}');
    expect(parsed).toEqual({ ok: true, value: { facts: [] } });
  });

  it("recovers JSON inside a fenced block", () => {
    const parsed = parseMemoryJson('```json\n{"facts":[{"content":"x"}]}\n```');
    expect(parsed.ok && Array.isArray((parsed.value as { facts: unknown[] }).facts)).toBe(true);
  });

  it("recovers JSON with a spoken preamble", () => {
    const parsed = parseMemoryJson('Here you go:\n{"facts":[]}\nHope that helps.');
    expect(parsed).toEqual({ ok: true, value: { facts: [] } });
  });

  it("rejects text with no JSON object", () => {
    expect(parseMemoryJson("I could not find any facts.")).toEqual({ ok: false });
  });

  it("rejects malformed JSON", () => {
    expect(parseMemoryJson('{"facts":[')).toEqual({ ok: false });
  });
});

describe("isValidExtractedFact", () => {
  it("accepts a fact with content and an optional date", () => {
    expect(
      isValidExtractedFact({ content: "The user prefers dark mode.", occurredAt: "2026-01-02" }),
    ).toBe(true);
  });

  it("rejects content shorter than a durable statement", () => {
    expect(isValidExtractedFact({ content: "ok" })).toBe(false);
  });

  it("rejects non-objects and missing content", () => {
    for (const value of [null, undefined, "fact", 42, {}, { content: 7 }]) {
      expect(isValidExtractedFact(value)).toBe(false);
    }
  });
});

describe("extractThreadMemories skip paths", () => {
  it("skips a thread with no bot before reading anything", async () => {
    const { extractThreadMemories } = await import("./extract.js");
    const prisma = {
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "t",
          spaceId: "s",
          userId: "u",
          botId: null,
          historyCompactionSummary: null,
        })),
      },
      memoryThreadProgress: { findUnique: vi.fn() },
      message: { findMany: vi.fn() },
    };
    const result = await extractThreadMemories(
      {
        prisma: prisma as never,
        runtime: {} as never,
        embeddingFor: vi.fn(),
        resolveModel: vi.fn(),
      },
      "t",
    );
    expect(result).toEqual({ extracted: 0, skipped: "no-bot" });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("skips when nothing is past the cursor", async () => {
    const { extractThreadMemories } = await import("./extract.js");
    const prisma = {
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "t",
          spaceId: "s",
          userId: "u",
          botId: "b",
          historyCompactionSummary: null,
        })),
      },
      memoryThreadProgress: { findUnique: vi.fn(async () => ({ lastExtractedSeq: 10 })) },
      message: { findMany: vi.fn(async () => []) },
    };
    const result = await extractThreadMemories(
      {
        prisma: prisma as never,
        runtime: {} as never,
        embeddingFor: vi.fn(),
        resolveModel: vi.fn(),
      },
      "t",
    );
    expect(result).toEqual({ extracted: 0, skipped: "nothing-new" });
  });
});
