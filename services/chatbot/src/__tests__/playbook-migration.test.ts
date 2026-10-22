/**
 * The playbook canvas as "New conversation" automations (2026-10-22): what is
 * carried, the fallback, and that nothing is dropped silently.
 */
import { describe, it, expect } from "vitest";
import { planPlaybookMigration } from "../lib/playbook-migration";

const entry = (id: string, channelType: string) => ({ id, type: "channel_entry", data: { channelType, channelId: `acc_${id}` }, position: { x: 0, y: 0 } });
const route = (id: string, targetId: string | null, routeType = "agent") => ({ id, type: "route_target", data: { routeType, targetId }, position: { x: 300, y: 0 } });
const edge = (s: string, t: string, sourceHandle?: string) => ({ id: `e-${s}-${t}`, source: s, target: t, ...(sourceHandle ? { sourceHandle } : {}) });

describe("★ a demo-shaped playbook (5 entries, 4 routes to one employee)", () => {
  const canvas = {
    nodes: [
      entry("wa", "whatsapp"), entry("ms", "messenger"), entry("ig", "instagram"), entry("gm", "gmail"), entry("sh", "shopify_live_chat"),
      route("r1", "noa"), route("r2", "noa"), route("r3", "noa"), route("r4", "noa"),
    ],
    edges: [edge("wa", "r1"), edge("ms", "r2"), edge("ig", "r3"), edge("gm", "r4")],
  };
  const plan = planPlaybookMigration(canvas);

  it("one automation per routed channel: trigger -> hand to AI, the employee kept", () => {
    const own = plan.automations.filter((a) => a.channels.length);
    expect(own.map((a) => a.channels[0])).toEqual(["WHATSAPP", "MESSENGER", "INSTAGRAM", "GMAIL"]);
    for (const a of own) {
      expect(a.nodes.map((n) => n.type)).toEqual(["automation_trigger", "hand_to_ai"]);
      expect(a.nodes[1]!.data.aiAgentId).toBe("noa");
      expect(a.edges).toEqual([expect.objectContaining({ source: "trigger", target: a.nodes[1]!.id })]);
    }
  });

  it("★ the first entry is also the every-other-channel automation (the canvas's fallback)", () => {
    const fb = plan.automations.filter((a) => a.channels.length === 0);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.fromEntryId).toBe("wa");
  });

  it("★ the entry that leads nowhere is reported, not dropped silently", () => {
    expect(plan.notMigrated.some((r) => r.includes("entry sh") && r.includes("leads nowhere"))).toBe(true);
    expect(plan.automations.some((a) => a.channels.includes("SHOPIFY_LIVE_CHAT"))).toBe(false);
  });
});

describe("★ quick replies and branches are carried as they are", () => {
  it("send_message_quick_reply with per-reply branches to two employees", () => {
    const plan = planPlaybookMigration({
      nodes: [
        entry("wa", "whatsapp"),
        { id: "q", type: "send_message_quick_reply", data: { text: "Sales or support?", replies: [{ label: "Sales", payload: "sales" }, { label: "Support", payload: "support" }] } },
        route("toSales", "dana"), route("toSupport", "noa"),
      ],
      edges: [edge("wa", "q"), edge("q", "toSales", "sales"), edge("q", "toSupport", "support")],
    });
    const a = plan.automations.find((x) => x.channels[0] === "WHATSAPP")!;
    expect(a.nodes.map((n) => [n.id, n.type])).toEqual([["trigger", "automation_trigger"], ["q", "send_message_quick_reply"], ["toSales", "hand_to_ai"], ["toSupport", "hand_to_ai"]]);
    expect(a.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "trigger", target: "q" }),
      expect.objectContaining({ source: "q", target: "toSales", sourceHandle: "sales" }),
      expect.objectContaining({ source: "q", target: "toSupport", sourceHandle: "support" }),
    ]));
    expect(a.nodes.find((n) => n.id === "q")!.data.replies).toHaveLength(2);
  });

  it("a team route becomes assign-to-team, the same dispatch", () => {
    const plan = planPlaybookMigration({ nodes: [entry("wa", "whatsapp"), route("t", "dept_1", "human")], edges: [edge("wa", "t")] });
    expect(plan.automations[0]!.nodes[1]).toMatchObject({ type: "assign", data: { to: "team", departmentId: "dept_1" } });
  });
});

describe("★ nothing is dropped silently", () => {
  it("a route to a sub-flow: reported, that channel not migrated", () => {
    const plan = planPlaybookMigration({ nodes: [entry("wa", "whatsapp"), route("f", "flow_1", "flow")], edges: [edge("wa", "f")] });
    expect(plan.automations).toHaveLength(0);
    expect(plan.notMigrated.join(" ")).toContain("sub-flow");
  });

  it("a route naming nobody: reported", () => {
    const plan = planPlaybookMigration({ nodes: [entry("ig", "instagram"), route("r", null)], edges: [edge("ig", "r")] });
    expect(plan.notMigrated.join(" ")).toContain("names nobody");
  });

  it("★ other triggers on the canvas: the whole canvas is refused (emptying it would switch them off)", () => {
    const plan = planPlaybookMigration({ nodes: [entry("wa", "whatsapp"), route("r", "noa"), { id: "c", type: "comment_trigger", data: {} }], edges: [edge("wa", "r")] });
    expect(plan.migratable).toBe(false);
    expect(plan.refused).toContain("comment_trigger");
    expect(plan.automations).toHaveLength(0);
  });

  it("a second entry for the same channel never ran: reported", () => {
    const plan = planPlaybookMigration({ nodes: [entry("a", "whatsapp"), entry("b", "whatsapp"), route("r", "noa")], edges: [edge("a", "r"), edge("b", "r")] });
    expect(plan.automations.filter((x) => x.channels[0] === "WHATSAPP")).toHaveLength(1);
    expect(plan.notMigrated.join(" ")).toContain("entry b");
  });

  it("an unknown channel and an unreachable step are reported", () => {
    const plan = planPlaybookMigration({ nodes: [entry("x", "fax"), route("lonely", "noa")], edges: [] });
    expect(plan.notMigrated.join(" ")).toContain('unknown channel "fax"');
    expect(plan.notMigrated.join(" ")).toContain("step lonely");
  });
});

describe("the walker's rule", () => {
  it("an entry follows its FIRST edge only, as the canvas walker does", () => {
    const plan = planPlaybookMigration({ nodes: [entry("wa", "whatsapp"), route("first", "noa"), route("second", "dana")], edges: [edge("wa", "first"), edge("wa", "second")] });
    const a = plan.automations.find((x) => x.channels[0] === "WHATSAPP")!;
    expect(a.nodes.map((n) => n.id)).toEqual(["trigger", "first"]);
    expect(plan.notMigrated.join(" ")).not.toContain("second");
  });
});

describe("start-only playbook", () => {
  it("one automation for every channel", () => {
    const plan = planPlaybookMigration({ nodes: [{ id: "s", type: "start", data: {} }, route("r", "maya")], edges: [edge("s", "r")] });
    expect(plan.automations).toHaveLength(1);
    expect(plan.automations[0]).toMatchObject({ channels: [], fromEntryId: "s" });
  });

  it("an empty canvas plans nothing", () => {
    expect(planPlaybookMigration({ nodes: [], edges: [] })).toMatchObject({ migratable: true, automations: [], notMigrated: [] });
  });
});
