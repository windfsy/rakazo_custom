import { describe, expect, it, vi } from "vitest";
import type { EvalJudge } from "./judge.js";
import {
  consolidationEvidence,
  dreamEvidence,
  extractionEvidence,
  MEMORY_EXTRACTION_CASES,
  MEMORY_JUDGE_CALIBRATION,
  MEMORY_JUDGE_VERSION,
  memoryRubric,
} from "./memory.js";
import { calibrateMemoryJudge } from "./memory-judge.js";

describe("memory eval fixtures", () => {
  it("versions every rubric under the declared judge version", () => {
    for (const suite of ["extract", "consolidate", "dream"] as const) {
      expect(memoryRubric(suite)).toMatch(new RegExp(`^${MEMORY_JUDGE_VERSION}/`));
    }
  });

  it("keeps extraction case ids unique", () => {
    const ids = MEMORY_EXTRACTION_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every extraction case an explicit must-capture or must-avoid list", () => {
    for (const testCase of MEMORY_EXTRACTION_CASES) {
      expect(testCase.mustCapture.length + testCase.mustAvoid.length).toBeGreaterThan(0);
      expect(testCase.turns.length).toBeGreaterThan(0);
    }
  });

  it("calibrates every suite with reviewed labels in both directions", () => {
    for (const suite of ["extract", "consolidate", "dream"] as const) {
      const labels = MEMORY_JUDGE_CALIBRATION.filter((entry) => entry.suite === suite);
      expect(labels.some((entry) => entry.pass)).toBe(true);
      expect(labels.some((entry) => !entry.pass)).toBe(true);
    }
    // Every calibration label explains itself, so a reviewer can re-judge it.
    for (const entry of MEMORY_JUDGE_CALIBRATION) expect(entry.why.length).toBeGreaterThan(10);
  });

  it("builds judge inputs that name the rubric and carry the case", () => {
    const extraction = extractionInput("durable-preference");
    expect(extraction.rubric).toBe(memoryRubric("extract"));
    expect(JSON.stringify(extraction.evidence)).toContain("durable-preference");

    const consolidation = consolidationEvidence({
      facts: [{ id: "f1", content: "a" }],
      superseded: [],
      expired: [],
    });
    expect(consolidation.rubric).toBe(memoryRubric("consolidate"));

    const dream = dreamEvidence({ sources: [], derived: [] });
    expect(dream.rubric).toBe(memoryRubric("dream"));
  });
});

describe("calibrateMemoryJudge", () => {
  it("passes when the judge agrees with every reviewed label", async () => {
    const judge: EvalJudge = vi.fn(async (input) => ({
      pass: expectedFor(input),
      reason: "agrees",
    }));
    const result = await calibrateMemoryJudge(judge);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(MEMORY_JUDGE_CALIBRATION.length);
    expect(judge).toHaveBeenCalledTimes(MEMORY_JUDGE_CALIBRATION.length);
  });

  it("stops at the first disagreement", async () => {
    const spy = vi.fn(async () => ({ pass: true, reason: "always pass" }));
    const result = await calibrateMemoryJudge(spy);
    expect(result.ok).toBe(false);
    // The first label is a pass, so the first negative label is where it fails.
    expect(result.results.length).toBeLessThan(MEMORY_JUDGE_CALIBRATION.length);
    expect(result.results.at(-1)?.expected).toBe(false);
    expect(spy.mock.calls.length).toBe(result.results.length);
  });

  it("surfaces a judge error rather than reporting a pass", async () => {
    const judge: EvalJudge = async () => {
      throw new Error("provider unavailable");
    };
    await expect(calibrateMemoryJudge(judge)).rejects.toThrow("provider unavailable");
  });
});

/** What a calibrated judge should answer for this input, read from the fixtures. */
function expectedFor(input: { rubric: string; evidence: unknown }): boolean {
  const suite = input.rubric.startsWith(`${MEMORY_JUDGE_VERSION}/extract`)
    ? "extract"
    : input.rubric.startsWith(`${MEMORY_JUDGE_VERSION}/consolidate`)
      ? "consolidate"
      : "dream";
  const serialized = JSON.stringify(input.evidence);
  const match = MEMORY_JUDGE_CALIBRATION.find(
    (entry) => entry.suite === suite && JSON.stringify(entry.evidence) === serialized,
  );
  if (!match) throw new Error("unreviewed evidence reached the judge");
  return match.pass;
}

function extractionInput(caseId: string) {
  const testCase = MEMORY_EXTRACTION_CASES.find((entry) => entry.id === caseId)!;
  return extractionEvidence(testCase, []);
}
