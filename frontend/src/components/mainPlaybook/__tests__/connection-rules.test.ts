import { describe, it, expect } from "vitest";
import { NODE_REGISTRY } from "../node-registry";
import {
  getNodePorts,
  canConnectPorts,
  validateConnection,
  createsCycle,
  leftBoundaryX,
} from "../connection-rules";

// Discover representative node types from the REAL registry so the test stays
// correct as node types evolve.
const entryType = Object.keys(NODE_REGISTRY).find((t) => getNodePorts(t).inputs.length === 0)!;
const terminalType = Object.keys(NODE_REGISTRY).find((t) => getNodePorts(t).outputs.length === 0 && getNodePorts(t).inputs.length > 0)!;
const stepType = Object.keys(NODE_REGISTRY).find((t) => getNodePorts(t).inputs.length > 0 && getNodePorts(t).outputs.length > 0)!;

describe("§3 port derivation from the registry", () => {
  it("derives entry (no input), terminal (no output) and step (both) ports", () => {
    expect(entryType).toBeTruthy();
    expect(terminalType).toBeTruthy();
    expect(stepType).toBeTruthy();
    expect(getNodePorts(entryType).inputs).toHaveLength(0);
    expect(getNodePorts(terminalType).outputs).toHaveLength(0);
    const step = getNodePorts(stepType);
    expect(step.inputs.length).toBeGreaterThan(0);
    expect(step.outputs.length).toBeGreaterThan(0);
  });
});

describe("§3 canConnectPorts type compatibility", () => {
  it("allows control flow and wildcards", () => {
    expect(canConnectPorts("flow", "flow")).toBe(true);
    expect(canConnectPorts("branch", "flow")).toBe(true);
    expect(canConnectPorts("any", "message")).toBe(true);
    expect(canConnectPorts("participant", "any")).toBe(true);
  });
  it("§13 forbids a participant event feeding a message input", () => {
    expect(canConnectPorts("participant_event", "message")).toBe(false);
  });
});

describe("§3 validateConnection rejects invalid graph edits", () => {
  const nodes = [
    { id: "e1", type: entryType },
    { id: "s1", type: stepType },
    { id: "s2", type: stepType },
    { id: "t1", type: terminalType },
  ];

  it("§12 rejects a self-loop", () => {
    expect(validateConnection({ source: "s1", target: "s1" }, nodes, []).code).toBe("self_loop");
  });

  it("rejects connecting INTO an entry/start node (no input)", () => {
    expect(validateConnection({ source: "s1", target: "e1" }, nodes, []).code).toBe("no_input");
  });

  it("rejects connecting OUT of a terminal node (no output)", () => {
    expect(validateConnection({ source: "t1", target: "s1" }, nodes, []).code).toBe("no_output");
  });

  it("rejects a second edge into a single-input node", () => {
    const edges = [{ id: "x", source: "e1", target: "s1" }];
    expect(validateConnection({ source: "s2", target: "s1" }, nodes, edges).code).toBe("single_input");
  });

  it("rejects a connection that would create a cycle", () => {
    const edges = [
      { id: "a", source: "s1", target: "s2" },
    ];
    // s2 -> s1 closes a loop.
    expect(validateConnection({ source: "s2", target: "s1" }, nodes, edges).code).toBe("cycle");
  });

  it("accepts a valid forward connection", () => {
    expect(validateConnection({ source: "e1", target: "s1" }, nodes, []).ok).toBe(true);
  });
});

describe("§7 static entry defines the left canvas boundary (graph-space)", () => {
  it("§21 the leftmost entry node anchors the boundary (minus padding)", () => {
    const nodes = [
      { position: { x: 400, y: 0 }, type: "start" },     // entry
      { position: { x: 900, y: 0 }, type: "send_message_text" },
    ];
    expect(leftBoundaryX(nodes, 120)).toBe(280); // 400 - 120
  });
  it("§22/§23 rightward nodes never move the boundary left; entries win over other nodes", () => {
    const nodes = [
      { position: { x: 500, y: 0 }, type: "channel_entry" }, // entry anchor
      { position: { x: -300, y: 0 }, type: "send_message_text" }, // a step dragged far left
    ];
    // Boundary follows the ENTRY (500-120=380), not the stray step at -300.
    expect(leftBoundaryX(nodes, 120)).toBe(380);
  });
  it("falls back to the leftmost node when no entry exists yet", () => {
    const nodes = [{ position: { x: 50, y: 0 }, type: "send_message_text" }];
    expect(leftBoundaryX(nodes, 120)).toBe(-70);
  });
});

describe("createsCycle", () => {
  it("detects reachability back to the source", () => {
    expect(createsCycle("a", "b", [{ source: "b", target: "a" }])).toBe(true);
    expect(createsCycle("a", "b", [{ source: "b", target: "c" }])).toBe(false);
  });
});
