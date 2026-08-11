import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFlow } from "../flow-validator";

// Minimal node/edge shims (validateFlow only reads id/type/data + source/target).
const n = (id: string, type: string, data: any = {}) => ({ id, type, data, position: { x: 0, y: 0 } }) as any;
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, sourceHandle }) as any;
const ids = (issues: { id: string }[]) => issues.map((i) => i.id);

describe("§3 frontend flow-validator new rules (parity with backend graph-validator)", () => {
  it("flags duplicate singleton static nodes (two starts)", () => {
    const issues = validateFlow([n("s1", "start"), n("s2", "start")], []);
    expect(ids(issues)).toContain("duplicate_start");
  });

  it("flags an invalid (non-positive) wait delay, warns when unset", () => {
    const bad = validateFlow([n("s", "start"), n("w", "wait", { durationMs: 0 })], [e("s", "w")]);
    expect(bad.some((i) => i.id === "w__bad_delay" && i.severity === "error")).toBe(true);
    const unset = validateFlow([n("s", "start"), n("w", "wait", {})], [e("s", "w")]);
    expect(unset.some((i) => i.id === "w__bad_delay")).toBe(false);
    expect(unset.some((i) => i.id === "w__no_delay" && i.severity === "warning")).toBe(true);
  });

  it("a valid positive delay produces no delay error", () => {
    const issues = validateFlow([n("s", "start"), n("w", "wait", { durationMs: 3000 })], [e("s", "w")]);
    expect(issues.some((i) => i.id.endsWith("bad_delay"))).toBe(false);
  });
});

describe("§3 FE↔BE validator parity: shared codes exist on both sides", () => {
  // The backend authoritative validator lives in another package; assert the
  // source declares the same new checks so the two never silently diverge.
  const beSrc = readFileSync(
    join(__dirname, "../../../../../services/chatbot/src/lib/graph-validator.ts"),
    "utf8",
  );
  const feSrc = readFileSync(join(__dirname, "../flow-validator.ts"), "utf8");

  it("backend declares duplicate_entry, invalid_delay, branch_incomplete", () => {
    for (const code of ["duplicate_entry", "invalid_delay", "branch_incomplete"]) {
      expect(beSrc, code).toContain(`"${code}"`);
    }
  });
  it("both sides share the singleton-static-node set", () => {
    expect(beSrc).toMatch(/SINGLETON_TYPES = new Set\(\["start", "default_fallback"\]\)/);
    expect(feSrc).toMatch(/SINGLETON_TYPES = new Set\(\["start", "default_fallback"\]\)/);
  });
});

// ─── Nodes stranded behind a terminal step ──────────────────────
//
// The incident shape: a flow sent its first message, handed off at a route
// step, and the send_message / send_interactive drawn AFTER that step never
// ran. They had an incoming edge, so the dangling-node rule stayed quiet, and
// the author saw a clean canvas.
describe("§3 unreachable-after-terminal", () => {
  const chain = [
    n("s", "channel_entry"),
    n("m1", "send_message_text", { text: "step 1" }),
    n("r", "route_target", { routeType: "agent", targetId: "agent-1" }),
    n("m2", "send_message_text", { text: "never runs" }),
    n("i1", "send_message_interactive", { text: "never runs either" }),
  ];
  const wiring = [e("s", "m1"), e("m1", "r"), e("r", "m2"), e("m2", "i1")];

  it("flags every node drawn after a route step", () => {
    const issues = validateFlow(chain, wiring);
    expect(ids(issues)).toContain("m2__after_terminal");
    expect(ids(issues)).toContain("i1__after_terminal");
  });

  it("does not flag the nodes that precede the route step", () => {
    const issues = validateFlow(chain, wiring);
    expect(ids(issues)).not.toContain("m1__after_terminal");
    expect(ids(issues)).not.toContain("r__after_terminal");
  });

  it("stays quiet on the same nodes wired BEFORE the route step", () => {
    const ok = validateFlow(chain, [e("s", "m1"), e("m1", "m2"), e("m2", "i1"), e("i1", "r")]);
    expect(ids(ok).some((i) => i.endsWith("__after_terminal"))).toBe(false);
  });

  it("treats end as terminal too", () => {
    const issues = validateFlow(
      [n("s", "channel_entry"), n("x", "end", { kind: "close" }), n("m", "send_message_text", { text: "hi" })],
      [e("s", "x"), e("x", "m")],
    );
    expect(ids(issues)).toContain("m__after_terminal");
  });
});
