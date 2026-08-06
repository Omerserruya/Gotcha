/**
 * The handle a trigger card renders must be a port the validator knows about.
 *
 * A customer reported: "the workflow node connection is broke !!! i [can't]
 * connect between trigger such channel entry into actions such send
 * text/interactive". Every drag out of a trigger card was silently refused.
 *
 * Why: TriggerCardNode renders its one source handle with a literal
 * id="out", but the registry declared `sources: [{ position: "bottom" }]` with
 * no id, so getNodePorts derived the port id "0". React Flow hands
 * onConnect `sourceHandle: "out"`; validateConnection looked for a port named
 * "out", found only "0", and returned `no_output`. Since TriggerCardNode
 * renders EVERY trigger type, no trigger in the builder could reach any action.
 *
 * The existing connection-rules test missed it by omitting sourceHandle, which
 * falls back to outputs[0] - a path the real canvas never takes.
 */
import { describe, it, expect } from "vitest";
import { NODE_REGISTRY, TRIGGER_SOURCE_HANDLE } from "../node-registry";
import { getNodePorts, validateConnection } from "../connection-rules";
import { TRIGGER_TYPES } from "../trigger-types";

/** Trigger types that are in the registry and so can appear on the canvas. */
const triggerTypes = Array.from(TRIGGER_TYPES).filter((t) => NODE_REGISTRY[t]);

describe("every trigger's rendered handle id resolves to a real port", () => {
  it("covers the trigger types the canvas can actually create", () => {
    // Guard against the list silently emptying and the suite passing vacuously.
    expect(triggerTypes.length).toBeGreaterThanOrEqual(5);
    expect(triggerTypes).toContain("channel_entry");
  });

  for (const type of triggerTypes) {
    it(`${type}: port id matches the handle TriggerCardNode renders`, () => {
      const outputs = getNodePorts(type, NODE_REGISTRY[type].defaultData()).outputs;
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.some((p) => p.id === TRIGGER_SOURCE_HANDLE)).toBe(true);
    });

    it(`${type}: connects to an action with the handle the canvas sends`, () => {
      const nodes = [
        { id: "trg", type, data: NODE_REGISTRY[type].defaultData() },
        { id: "act", type: "send_message_text", data: {} },
      ];
      const res = validateConnection(
        { source: "trg", target: "act", sourceHandle: TRIGGER_SOURCE_HANDLE, targetHandle: null },
        nodes,
        [],
      );
      expect(res.code).toBeUndefined();
      expect(res.ok).toBe(true);
    });
  }
});

/**
 * The same class of bug on any node whose component hardcodes a handle id.
 * A port the renderer can emit but the validator cannot name is unconnectable,
 * so the two must be derived from one source: the registry.
 */
describe("no node declares a source it cannot be connected from", () => {
  for (const [type, entry] of Object.entries(NODE_REGISTRY)) {
    const data = entry.defaultData();
    // Multi-exit nodes carry explicit ids; getSources nodes (one exit per
    // quick-reply button) have none until the author adds buttons.
    if (getNodePorts(type, data).outputs.length !== 1) continue;
    it(`${type}: single exit is reachable by its own declared id`, () => {
      const [port] = getNodePorts(type, data).outputs;
      const nodes = [
        { id: "a", type, data: entry.defaultData() },
        { id: "b", type: "send_message_text", data: {} },
      ];
      expect(validateConnection({ source: "a", target: "b", sourceHandle: port.id }, nodes, []).ok).toBe(true);
    });
  }
});
