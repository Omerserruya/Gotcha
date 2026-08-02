import { describe, it, expect } from "vitest";
import { validateGraph } from "../lib/graph-validator";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("§3 authoritative graph validation (backend, gates publish)", () => {
  it("§14 an empty graph is an error", () => {
    const { errors } = validateGraph([], []);
    expect(codes(errors)).toContain("empty");
  });

  it("requires a start/entry node", () => {
    const nodes = [{ id: "a", type: "send_message_text", data: { text: "hi" } }];
    const { errors } = validateGraph(nodes, []);
    expect(codes(errors)).toContain("no_start");
  });

  it("§14 rejects a cycle (must flow forward)", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "a", type: "send_message_text", data: { text: "hi" } },
      { id: "b", type: "send_message_text", data: { text: "yo" } },
    ];
    const edges = [
      { source: "s", target: "a" },
      { source: "a", target: "b" },
      { source: "b", target: "a" }, // cycle
    ];
    expect(codes(validateGraph(nodes, edges).errors)).toContain("cycle");
  });

  it("§15 missing required configuration blocks publish", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "a", type: "send_message_text", data: {} }, // no text
    ];
    const edges = [{ source: "s", target: "a" }];
    expect(codes(validateGraph(nodes, edges).errors)).toContain("missing_config");
  });

  it("rejects a connection INTO a start node (no input)", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "a", type: "send_message_text", data: { text: "hi" } },
    ];
    const edges = [{ source: "a", target: "s" }];
    expect(codes(validateGraph(nodes, edges).errors)).toContain("no_input");
  });

  it("§(deleted nodes) flags a broken edge to a removed node", () => {
    const nodes = [{ id: "s", type: "start" }];
    const edges = [{ source: "s", target: "ghost" }];
    expect(codes(validateGraph(nodes, edges).errors)).toContain("broken_edge");
  });

  it("a clean linear process has no errors (warnings allowed)", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "a", type: "send_message_text", data: { text: "hi" } },
      { id: "e", type: "end" },
    ];
    const edges = [
      { source: "s", target: "a" },
      { source: "a", target: "e" },
    ];
    const { errors } = validateGraph(nodes, edges);
    expect(errors).toHaveLength(0);
  });

  it("warns on unreachable steps without blocking publish", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "a", type: "send_message_text", data: { text: "hi" } },
      { id: "orphan", type: "send_message_text", data: { text: "lost" } },
    ];
    const edges = [{ source: "s", target: "a" }];
    const { errors, warnings } = validateGraph(nodes, edges);
    expect(errors).toHaveLength(0);
    expect(codes(warnings)).toContain("unreachable");
  });

  it("§3 rejects duplicate singleton static nodes (two starts)", () => {
    const nodes = [
      { id: "s1", type: "start" },
      { id: "s2", type: "start" },
      { id: "a", type: "send_message_text", data: { text: "hi" } },
    ];
    const edges = [{ source: "s1", target: "a" }];
    expect(codes(validateGraph(nodes, edges).errors)).toContain("duplicate_entry");
  });

  it("§3 rejects an invalid delay (non-positive) and warns when unset", () => {
    const bad = validateGraph(
      [{ id: "s", type: "start" }, { id: "w", type: "wait", data: { durationMs: 0 } }, { id: "e", type: "end" }],
      [{ source: "s", target: "w" }, { source: "w", target: "e" }],
    );
    expect(codes(bad.errors)).toContain("invalid_delay");
    const unset = validateGraph(
      [{ id: "s", type: "start" }, { id: "w", type: "wait", data: {} }, { id: "e", type: "end" }],
      [{ source: "s", target: "w" }, { source: "w", target: "e" }],
    );
    expect(codes(unset.errors)).not.toContain("invalid_delay");
    expect(codes(unset.warnings)).toContain("invalid_delay");
  });

  it("§3 a valid positive delay is accepted", () => {
    const { errors } = validateGraph(
      [{ id: "s", type: "start" }, { id: "w", type: "wait", data: { durationMs: 5000 } }, { id: "e", type: "end" }],
      [{ source: "s", target: "w" }, { source: "w", target: "e" }],
    );
    expect(codes(errors)).not.toContain("invalid_delay");
  });

  it("§3 warns when a reachable condition branch is left unconnected", () => {
    const nodes = [
      { id: "s", type: "start" },
      { id: "c", type: "condition_group", data: {} },
      { id: "t", type: "route_target", data: { targetId: "team-1" } },
    ];
    const edges = [
      { source: "s", target: "c" },
      { source: "c", target: "t", sourceHandle: "true" }, // only one branch wired
    ];
    const { warnings } = validateGraph(nodes, edges);
    expect(codes(warnings)).toContain("branch_incomplete");
  });
});
