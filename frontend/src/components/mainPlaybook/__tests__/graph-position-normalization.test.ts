import { describe, it, expect } from "vitest";
import {
  normalizeGraphPositions,
  positionsAreNormalized,
  leftBoundaryX,
  TRIGGER_COLUMN_X,
  MIN_BODY_OFFSET_X,
} from "../connection-rules";

const trig = (x: number, y = 0, type = "keyword_trigger") => ({ id: `t${x}_${y}`, type, position: { x, y } });
const step = (x: number, y = 0) => ({ id: `s${x}_${y}`, type: "send_message", position: { x, y } });

describe("normalizeGraphPositions - triggers really are on the left", () => {
  it("pins a trigger imported at a wild negative X into the trigger column", () => {
    // The bug this exists for: leftBoundaryX derives the boundary FROM the
    // nodes, so a trigger at -5000 dragged the boundary out with it and the
    // rule held vacuously while the canvas opened on empty space.
    const out = normalizeGraphPositions([trig(-5000), step(-4600)]);
    expect(out[0].position.x).toBe(TRIGGER_COLUMN_X);
    expect(out[1].position.x).toBeGreaterThanOrEqual(TRIGGER_COLUMN_X + MIN_BODY_OFFSET_X);
  });

  it("leaves an already-sane graph untouched", () => {
    const nodes = [trig(0, 0), step(400, 0), step(800, 120)];
    expect(normalizeGraphPositions(nodes)).toEqual(nodes);
    expect(positionsAreNormalized(nodes)).toBe(true);
  });

  it("keeps every trigger's Y so their author-chosen order survives", () => {
    const out = normalizeGraphPositions([trig(-100, 300), trig(-100, 0), trig(-100, 150)]);
    expect(out.map((n) => n.position.y)).toEqual([300, 0, 150]);
    expect(out.every((n) => n.position.x === TRIGGER_COLUMN_X)).toBe(true);
  });

  it("aligns multiple triggers into one column even when they arrive scattered", () => {
    const out = normalizeGraphPositions([trig(-40, 0), trig(180, 100), trig(-900, 200)]);
    expect(new Set(out.map((n) => n.position.x))).toEqual(new Set([TRIGGER_COLUMN_X]));
  });

  it("shifts the whole body right rather than collapsing it", () => {
    // Relative spacing between downstream nodes must survive the shift, or the
    // author's layout is destroyed to satisfy the boundary.
    const out = normalizeGraphPositions([trig(0), step(-500, 0), step(-100, 0)]);
    const xs = out.filter((n) => n.type === "send_message").map((n) => n.position.x);
    expect(xs[1] - xs[0]).toBe(400);
    expect(Math.min(...xs)).toBe(TRIGGER_COLUMN_X + MIN_BODY_OFFSET_X);
  });

  it("never moves the body LEFT when it is already clear of the column", () => {
    const nodes = [trig(0), step(2000, 0)];
    expect(normalizeGraphPositions(nodes)[1].position.x).toBe(2000);
  });

  it("repairs NaN / missing coordinates instead of poisoning the whole graph", () => {
    const broken = [
      { id: "a", type: "keyword_trigger", position: { x: NaN, y: 10 } },
      { id: "b", type: "send_message", position: { x: undefined as any, y: NaN } },
    ];
    const out = normalizeGraphPositions(broken);
    for (const n of out) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("does not mutate the input", () => {
    const nodes = [trig(-800, 5)];
    const before = JSON.parse(JSON.stringify(nodes));
    normalizeGraphPositions(nodes);
    expect(nodes).toEqual(before);
  });

  it("handles an empty graph and a graph with no triggers at all", () => {
    expect(normalizeGraphPositions([])).toEqual([]);
    // No trigger yet (a brand-new canvas): the body still gets pushed clear of
    // the column so the trigger has somewhere to land.
    const out = normalizeGraphPositions([step(-300, 0)]);
    expect(out[0].position.x).toBe(TRIGGER_COLUMN_X + MIN_BODY_OFFSET_X);
  });

  it("is idempotent - normalizing twice changes nothing further", () => {
    const once = normalizeGraphPositions([trig(-5000), step(-4600), step(-9000, 90)]);
    expect(normalizeGraphPositions(once)).toEqual(once);
    expect(positionsAreNormalized(once)).toBe(true);
  });

  it("reports an un-normalized graph as such", () => {
    expect(positionsAreNormalized([trig(-5000), step(0)])).toBe(false);
  });
});

describe("leftBoundaryX after normalization", () => {
  it("puts the boundary just left of the trigger column, not out in space", () => {
    const out = normalizeGraphPositions([trig(-5000), step(-4600)]);
    const bound = leftBoundaryX(out.map((n) => ({ position: n.position, type: n.type })));
    expect(bound).toBe(TRIGGER_COLUMN_X - 120);
    // Nothing in the graph may sit left of the boundary.
    for (const n of out) expect(n.position.x).toBeGreaterThanOrEqual(bound);
  });
});
