/**
 * Routing nodes: what the validator demands vs what the runtime actually needs.
 *
 * flow-executor's dispatchRoute needs a targetId for an agent route (it assigns
 * assignedAiAgentId) and for a sub-flow route (it looks the flow up). A human
 * route needs nothing: with no target it parks the conversation in WAITING for
 * whoever claims it, and a department is an optional refinement.
 *
 * The panel demanded a target unconditionally, so switching a Route Target to
 * "human" - a complete, working node - raised an error the author could never
 * clear. And default_fallback, which the executor runs from the very same
 * `case`, had no rule at all, so an agent fallback with nothing selected passed
 * clean and then routed nowhere at message time.
 */
import { describe, it, expect } from "vitest";
import { validateFlow } from "../flow-validator";
import { NODE_REGISTRY } from "../node-registry";

/** Issues raised against one node, ignoring graph-shape rules. */
function fieldIssues(type: string, data: any) {
  const nodes = [
    { id: "t", type: "channel_entry", data: { channelType: "whatsapp" } },
    { id: "n", type, data },
  ];
  const edges = [{ id: "e", source: "t", target: "n" }];
  return validateFlow(nodes, edges).filter((i) => i.nodeId === "n" && i.id.includes("missing"));
}

for (const type of ["route_target", "default_fallback"]) {
  describe(`${type} target requirement`, () => {
    it("accepts a human route with no target", () => {
      expect(fieldIssues(type, { routeType: "human", targetId: "" })).toEqual([]);
    });

    it("accepts a human route sent to a department", () => {
      expect(fieldIssues(type, { routeType: "human", targetId: "dept_1" })).toEqual([]);
    });

    it("flags an agent route with nothing selected", () => {
      const issues = fieldIssues(type, { routeType: "agent", targetId: "" });
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("error");
    });

    it("flags a sub-flow route with nothing selected", () => {
      expect(fieldIssues(type, { routeType: "flow", targetId: "" })).toHaveLength(1);
    });

    it("accepts an agent route once an agent is picked", () => {
      expect(fieldIssues(type, { routeType: "agent", targetId: "agent_1" })).toEqual([]);
    });
  });
}

describe("the Route Target card's own status pip agrees with the panel", () => {
  const validate = NODE_REGISTRY.route_target.validate!;

  it("does not mark a human route as incomplete", () => {
    expect(validate({ routeType: "human", targetId: "" })).toBe("ok");
  });

  it("still marks an unselected agent route as incomplete", () => {
    expect(validate({ routeType: "agent", targetId: "" })).toBe("missing");
  });
});
