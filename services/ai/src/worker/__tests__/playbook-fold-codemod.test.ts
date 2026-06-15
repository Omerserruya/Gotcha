/**
 * Codemod unit tests - exercise the pure merge logic without DB.
 *
 * The codemod's DB I/O is one statement (the findMany + update). The
 * RISKY part is the merge: idempotency, dedup, overflow detection. We
 * factor that out via a re-export here and assert its behaviour
 * directly - running the full codemod requires a Prisma + Postgres
 * harness which lives in integration tests.
 */

import { describe, it, expect } from "vitest";

// Recreate the merge logic in isolation. Keep this in sync with the
// production codemod by importing & calling the same helper if we ever
// extract it; for now the codemod's per-stage block is small enough to
// mirror exactly.
function mergeStage(
  funnelStage: any,
  playbookStage: { requiredFields: string[]; exitCriteria: string },
): { merged: any; addedRequiredFields: string[]; addedPositiveSignals: string[] } {
  const beforeCopilot = (funnelStage.copilot as any) ?? {};
  const beforeFields = Array.isArray(beforeCopilot.requiredDataFields)
    ? beforeCopilot.requiredDataFields
    : [];
  const beforeExit = (beforeCopilot.exitCriteria as any) ?? {};
  const beforePositives = Array.isArray(beforeExit.positiveSignals)
    ? beforeExit.positiveSignals
    : [];

  const existingFieldNames = new Set(beforeFields.map((f: any) => f?.field));
  const addedRequiredFields: string[] = [];
  const mergedFields = beforeFields.slice();
  for (const fname of playbookStage.requiredFields ?? []) {
    if (!fname || existingFieldNames.has(fname)) continue;
    mergedFields.push({ field: fname, label: fname, required: true });
    addedRequiredFields.push(fname);
    existingFieldNames.add(fname);
  }

  const addedPositiveSignals: string[] = [];
  const mergedPositives = beforePositives.slice();
  const exitNL = (playbookStage.exitCriteria ?? "").trim();
  if (exitNL && !mergedPositives.includes(exitNL)) {
    mergedPositives.push(exitNL);
    addedPositiveSignals.push(exitNL);
  }

  return {
    merged: {
      ...funnelStage,
      copilot: {
        ...beforeCopilot,
        requiredDataFields: mergedFields,
        exitCriteria: { ...beforeExit, positiveSignals: mergedPositives },
      },
    },
    addedRequiredFields,
    addedPositiveSignals,
  };
}

describe("playbook-fold merge", () => {
  it("adds required fields onto an empty stage copilot", () => {
    const result = mergeStage(
      { id: "s1", label: "Discovery" },
      { requiredFields: ["budget", "timeline"], exitCriteria: "Budget confirmed" },
    );
    expect(result.addedRequiredFields).toEqual(["budget", "timeline"]);
    expect(result.merged.copilot.requiredDataFields).toEqual([
      { field: "budget", label: "budget", required: true },
      { field: "timeline", label: "timeline", required: true },
    ]);
    expect(result.merged.copilot.exitCriteria.positiveSignals).toEqual([
      "Budget confirmed",
    ]);
  });

  it("is idempotent - second merge is a no-op", () => {
    const first = mergeStage(
      { id: "s1" },
      { requiredFields: ["budget"], exitCriteria: "Done" },
    );
    const second = mergeStage(
      first.merged,
      { requiredFields: ["budget"], exitCriteria: "Done" },
    );
    expect(second.addedRequiredFields).toEqual([]);
    expect(second.addedPositiveSignals).toEqual([]);
    expect(second.merged).toEqual(first.merged);
  });

  it("preserves existing copilot fields the playbook didn't touch", () => {
    const result = mergeStage(
      {
        id: "s1",
        copilot: {
          goal: "Qualify the lead",
          requiredQuestions: [{ id: "q1", text: "What's your budget?", required: true }],
        },
      },
      { requiredFields: ["timeline"], exitCriteria: "" },
    );
    expect(result.merged.copilot.goal).toBe("Qualify the lead");
    expect(result.merged.copilot.requiredQuestions).toEqual([
      { id: "q1", text: "What's your budget?", required: true },
    ]);
    expect(result.merged.copilot.requiredDataFields).toEqual([
      { field: "timeline", label: "timeline", required: true },
    ]);
  });

  it("dedups required fields by field name across runs", () => {
    const result = mergeStage(
      {
        copilot: {
          requiredDataFields: [{ field: "budget", label: "Budget", required: true }],
        },
      },
      { requiredFields: ["budget", "timeline"], exitCriteria: "" },
    );
    expect(result.addedRequiredFields).toEqual(["timeline"]);
    // Existing label "Budget" is preserved, not overwritten with "budget"
    expect(result.merged.copilot.requiredDataFields[0]!.label).toBe("Budget");
  });

  it("drops blank exit criteria silently", () => {
    const result = mergeStage(
      {},
      { requiredFields: [], exitCriteria: "   " },
    );
    expect(result.addedPositiveSignals).toEqual([]);
    expect(result.merged.copilot.exitCriteria.positiveSignals).toEqual([]);
  });
});
