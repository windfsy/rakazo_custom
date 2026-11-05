import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";
import type { EvalJudge } from "./judge.js";
import {
  MEMORY_EXTRACTION_CASES,
  MEMORY_JUDGE_CALIBRATION,
  MEMORY_JUDGE_VERSION,
  memoryRubric,
} from "./memory.js";

export interface MemoryCalibrationResult {
  expected: boolean;
  pass: boolean;
  reason: string;
  suite: string;
}

/**
 * Runs every reviewed memory calibration label through the judge. A rubric that
 * disagrees with a human-labelled example is not qualified to grade anything, so the
 * first disagreement stops the run.
 */
export async function calibrateMemoryJudge(
  judge: EvalJudge,
  signal: AbortSignal = AbortSignal.timeout(60_000),
): Promise<
  | { ok: true; results: MemoryCalibrationResult[] }
  | { ok: false; results: MemoryCalibrationResult[]; error: string }
> {
  const results: MemoryCalibrationResult[] = [];
  for (const anchor of MEMORY_JUDGE_CALIBRATION) {
    const verdict = await judge(
      { rubric: memoryRubric(anchor.suite), evidence: anchor.evidence },
      signal,
    );
    results.push({
      expected: anchor.pass,
      pass: verdict.pass,
      reason: verdict.reason,
      suite: anchor.suite,
    });
    if (verdict.pass !== anchor.pass) {
      return {
        ok: false,
        results,
        error: `Judge disagreed with a reviewed ${anchor.suite} label (${anchor.why})`,
      };
    }
  }
  return { ok: true, results };
}

/** Facts the extraction prompt should be able to produce, one case at a time. */
export function memoryExtractionCaseIds(): string[] {
  return MEMORY_EXTRACTION_CASES.map((testCase) => testCase.id);
}

/** Model defaults for a memory judge: a small, deterministic-leaning model is enough. */
export function memoryJudgeModel(base: AgentRunModel): AgentRunModel {
  return { ...base, maxTokens: base.maxTokens ?? 1024 };
}

export const MEMORY_EVAL_VERSION = MEMORY_JUDGE_VERSION;
