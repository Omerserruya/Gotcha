/**
 * Pipeline snapshot mapper tests.
 *
 * Exercises the pure mapping from the legacy resolver output to the
 * worker-shaped snapshot. DB-coupled `resolvePipelineContext` is covered
 * by integration tests elsewhere — here we lock the data shape so a
 * resolver refactor can't silently drift the worker's pipeline section.
 */

import { describe, it, expect } from "vitest";
import { snapshotFromResolved } from "../pipeline/context";
import type { ResolvedStage } from "../../services/intelligence/stage-resolver.service";

function makeResolved(overrides: Partial<ResolvedStage> = {}): ResolvedStage {
  return {
    funnel: {
      tenantId: "t1",
      funnelId: "saas-default",
      departmentId: null,
      stages: [],
      transitions: [],
    },
    stage: {
      id: "discovery",
      label: "Discovery",
      baseStage: "initial" as any,
    },
    source: "crm-match",
    vendorStage: "Lead",
    nextStage: {
      id: "demo",
      label: "Demo",
      baseStage: "exploration" as any,
    },
    ...overrides,
  };
}

describe("snapshotFromResolved", () => {
  it("maps every field a skill renderer reads", () => {
    const snap = snapshotFromResolved(makeResolved());
    expect(snap).toEqual({
      funnelId: "saas-default",
      currentStageId: "discovery",
      currentStageLabel: "Discovery",
      nextStageId: "demo",
      nextStageLabel: "Demo",
    });
  });

  it("returns undefined nextStage* fields when no successor is configured", () => {
    const snap = snapshotFromResolved(makeResolved({ nextStage: null }));
    expect(snap.nextStageId).toBeUndefined();
    expect(snap.nextStageLabel).toBeUndefined();
    // current stage still populated
    expect(snap.currentStageId).toBe("discovery");
  });

  it("preserves stage label even when CRM fell back to first stage", () => {
    const snap = snapshotFromResolved(
      makeResolved({ source: "crm-fallback-first", vendorStage: "Unknown Status" }),
    );
    expect(snap.currentStageId).toBe("discovery");
  });
});
