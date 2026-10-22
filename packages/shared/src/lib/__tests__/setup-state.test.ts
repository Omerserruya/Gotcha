import { describe, it, expect } from "vitest";
import { computeSetupState, SETUP_STEPS, type SetupFacts } from "../setup-state";

const NONE: SetupFacts = { completed: {}, isLive: false, trial: null };
const AT = new Date("2026-09-08T10:00:00.000Z");

const state = (f: Partial<SetupFacts["completed"]>, rest: Partial<SetupFacts> = {}) =>
  computeSetupState({ ...NONE, ...rest, completed: f });

describe("computeSetupState", () => {
  it("marks exactly one step as next, always", () => {
    // A screen showing two "do this now" steps is showing neither.
    for (const done of [{}, { connect_channel: AT }, { connect_channel: AT, add_knowledge: AT }]) {
      const next = state(done).steps.filter((s) => s.state === "next");
      expect(next).toHaveLength(1);
    }
  });

  it("blocks a step on its unmet requirements and names them", () => {
    const hire = state({}).steps.find((s) => s.id === "hire_employee")!;
    expect(hire.state).toBe("blocked");
    expect(hire.blockedBy).toEqual(["add_knowledge"]);
  });

  it("unblocks a step the moment its requirement is done", () => {
    const hire = state({ add_knowledge: AT }).steps.find((s) => s.id === "hire_employee")!;
    expect(hire.state).not.toBe("blocked");
    expect(hire.blockedBy).toEqual([]);
  });

  it("distinguishes waiting from blocked", () => {
    // Both are "not yet", and conflating them is what the boolean tiles did.
    // waiting = startable, just not first. blocked = cannot be started at all.
    const steps = state({}).steps;
    const waiting = steps.filter((s) => s.state === "waiting");
    const blocked = steps.filter((s) => s.state === "blocked");
    expect(waiting.every((s) => s.blockedBy.length === 0)).toBe(true);
    expect(blocked.every((s) => s.blockedBy.length > 0)).toBe(true);
  });

  it("carries a completion timestamp on done steps and nothing else", () => {
    const steps = state({ connect_channel: AT }).steps;
    const done = steps.find((s) => s.id === "connect_channel")!;
    expect(done.state).toBe("done");
    expect(done.completedAt).toBe(AT.toISOString());
    expect(steps.filter((s) => s.state !== "done").every((s) => s.completedAt === null)).toBe(true);
  });

  it("seals go-live until every gating step is done, and says which", () => {
    const gating = SETUP_STEPS.filter((s) => s.gatesGoLive).map((s) => s.id);
    expect(state({}).goLive).toEqual({ eligible: false, blockedBy: gating });

    const all = Object.fromEntries(SETUP_STEPS.map((s) => [s.id, AT]));
    expect(state(all).goLive).toEqual({ eligible: true, blockedBy: [] });
  });

  it("does not let a non-gating step hold go-live", () => {
    // connect_store and invite_team are worth doing and are not blockers.
    const gatingDone = Object.fromEntries(
      SETUP_STEPS.filter((s) => s.gatesGoLive).map((s) => [s.id, AT]),
    );
    expect(state(gatingDone).goLive.eligible).toBe(true);
  });

  it("reports go-live blockers even when already live", () => {
    // A workspace taken back out of live mode still has to explain itself.
    const s = state({}, { isLive: true });
    expect(s.isLive).toBe(true);
    expect(s.goLive.eligible).toBe(false);
  });

  it("carries no titles or descriptions", () => {
    // Translated copy belongs in the frontend, keyed on id. Prose here would
    // repeat the mistake the insights endpoint had to be dug out of.
    const s = state({});
    for (const step of s.steps) {
      expect(Object.keys(step).sort()).toEqual(
        ["blockedBy", "completedAt", "estimateMinutes", "id", "state"],
      );
      // Ids are machine keys, so they carry no spaces and need no translating.
      expect(step.id).toMatch(/^[a-z_]+$/);
    }
  });

  it("passes the trial through untouched, null included", () => {
    expect(state({}).trial).toBeNull();
    const t = { daysRemaining: 12, conversationsUsed: 40 };
    expect(state({}, { trial: t }).trial).toEqual(t);
  });

  it("orders steps by what unblocks GOTCHA, not by effort", () => {
    // The cheapest step (invite_team, 2 minutes) must not lead.
    const ids = state({}).steps.map((s) => s.id);
    expect(ids[0]).toBe("connect_channel");
    expect(ids.indexOf("invite_team")).toBeGreaterThan(ids.indexOf("add_knowledge"));
  });
});
