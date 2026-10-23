/**
 * Onboarding go-live (2026-10-23): the first employee, hired from what the scan
 * learned, idempotent, READ order tools only, routing that never overwrites
 * the owner's playbook. In-memory rows; no model is called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  setting: new Map<string, string>(),
  agents: [] as any[],
  kbLinks: [] as any[],
  perms: [] as any[],
  canvas: null as any,
  depts: [] as any[],
  audits: [] as any[],
  discovery: null as any,
  tools: [] as any[],
  integrations: [] as any[],
  accounts: [] as any[],
  adapterCalls: [] as any[],
  adapterReply: { ok: true, result: { orders: [{ name: "#1043" }] } } as any,
  shops: [] as any[],
}));
vi.mock("../services/website-widget.service", () => ({
  installOf: async () => ({ shopify: H.shops }),
}));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: async (opts: any) => { H.adapterCalls.push(opts); return H.adapterReply; },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pick = (row: any, select: any) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  return {
    ...actual,
    readDurableSetting: async (_t: string, k: string) => H.setting.get(k) ?? null,
    writeDurableSetting: async (_t: string, k: string, v: string) => { H.setting.set(k, v); },
    defaultIntegrationAccess: async () => ["shopify"],
    prisma: {
      tenant: { findUnique: async () => ({ name: "Acme" }) },
      businessDiscovery: { findUnique: async () => H.discovery },
      businessProfile: { findUnique: async () => null },
      department: {
        findFirst: async () => H.depts[0] ?? null,
        create: async ({ data }: any) => { const d = { id: "dep1", slaTarget: null, autoGreetingEnabled: false, aiSuggestionsEnabled: true, escalateOnSlaBreach: false, autoCloseMinutes: null, ...data }; H.depts.push(d); return d; },
      },
      aIAgent: {
        findFirst: async ({ where }: any) => H.agents.find((a) => a.id === where.id && a.tenantId === where.tenantId) ?? null,
        create: async ({ data, select }: any) => { const a = { id: `ag${H.agents.length + 1}`, ...data }; H.agents.push(a); return pick(a, select); },
        update: async ({ where, data, select }: any) => { const a = H.agents.find((x) => x.id === where.id); Object.assign(a, data); return pick(a, select); },
      },
      knowledgeBase: { findMany: async () => [{ id: "kb1" }, { id: "kb2" }] },
      aIAgentKnowledge: {
        upsert: async ({ create }: any) => { if (!H.kbLinks.some((l) => l.aiAgentId === create.aiAgentId && l.knowledgeBaseId === create.knowledgeBaseId)) H.kbLinks.push(create); },
      },
      tenantIntegration: { findMany: async () => H.integrations },
      tenantTool: {
        findMany: async ({ where }: any) => H.tools.filter((t) => t.tenantIntegrationId === where.tenantIntegrationId && t.isEnabled
          && where.catalogTool.slug.in.includes(t.catalogTool.slug) && t.catalogTool.category === where.catalogTool.category),
      },
      agentToolPermission: {
        findFirst: async ({ where }: any) => H.perms.find((p) => p.aiAgentId === where.aiAgentId && p.tenantToolId === where.tenantToolId) ?? null,
        create: async ({ data }: any) => { H.perms.push({ id: `p${H.perms.length}`, ...data }); },
      },
      flowCanvas: {
        findUnique: async () => H.canvas,
        upsert: async ({ create, update }: any) => { H.canvas = H.canvas ? { ...H.canvas, ...update } : create; },
      },
      channelAccount: { findMany: async () => H.accounts },
      auditLog: { create: async ({ data }: any) => { H.audits.push(data); } },
    },
  };
});
vi.mock("../services/employee-reach.service", () => ({
  whereEmployeeAnswers: async (_t: string, agentId: string) => {
    const nodes = H.canvas?.nodes ?? [];
    const routes = nodes.some((n: any) => n.type === "route_target" && n.data?.targetId === agentId);
    return H.accounts.map((a) => ({ channel: a.channel, reach: routes ? "always" : "never", accounts: [] }));
  },
}));

import { goLiveEmployee, policyGuidelines, EMPLOYEE_SETTING, EMPLOYEE_HASH_SETTING } from "../services/onboarding-employee.service";

const POLICIES = [{ kind: "returns", summary: "Return within 30 days.", terms: { windowDays: 30, exchange: { allowed: true, how: "form" } } }];
const tool = (id: string, slug: string, category: string, ti = "ti-shop") => ({ id, tenantIntegrationId: ti, isEnabled: true, catalogTool: { slug, category } });

beforeEach(() => {
  H.setting = new Map(); H.agents = []; H.kbLinks = []; H.perms = []; H.canvas = null; H.depts = []; H.audits = [];
  H.adapterCalls = []; H.shops = []; H.adapterReply = { ok: true, result: { orders: [{ name: "#1043" }] } };
  H.discovery = {
    status: "COMPLETE", business: { name: "Acme", industry: "Fashion", summary: "Clothes" }, brand: { voice: "warm" },
    knowledge: { structured: { lang: "he", policies: POLICIES } }, recommendation: { employeeName: "מאיה" }, technology: {}, primaryGoal: null,
  };
  H.integrations = [{ id: "ti-shop", integration: { slug: "shopify" } }];
  H.tools = [tool("t1", "get_order", "READ"), tool("t2", "track_shipment", "READ"), tool("t3", "create_refund", "WRITE"), tool("t4", "get_order_edit", "READ")];
  H.accounts = [{ id: "ca1", channel: "WEBCHAT", displayName: "Site" }, { id: "ca2", channel: "WHATSAPP", displayName: "WA", connectionStatus: "CONNECTED" }];
});

describe("go-live", () => {
  it("hires the employee from what was learned: its name, ACTIVE, a department, the policy terms in its guidelines", async () => {
    const r = await goLiveEmployee({ tenantId: "T", actor: "u1" });
    expect(r).toMatchObject({ created: true, employee: { name: "מאיה", status: "ACTIVE" }, knowledgeBases: 2, policiesApplied: 1, warnings: [] });
    const a = H.agents[0];
    expect(a).toMatchObject({ status: "ACTIVE", role: "customer_support", departmentId: "dep1", builderStep: null, integrationAccess: ["shopify"] });
    expect(a.identity.representationGuidelines.join("\n")).toContain("Store policy (returns): Return within 30 days. [window 30 days; exchange allowed (form)]");
    expect(H.depts[0]).toMatchObject({ name: "שירות לקוחות" });
    expect(H.setting.get(EMPLOYEE_SETTING)).toBe(a.id);
    expect(H.kbLinks.map((l) => l.knowledgeBaseId)).toEqual(["kb1", "kb2"]);
    expect(H.audits).toEqual([expect.objectContaining({ action: "onboarding.go_live", targetId: a.id })]);
  });

  it("a second press updates the SAME employee: no second agent, no duplicate grants or links", async () => {
    const first = await goLiveEmployee({ tenantId: "T" });
    const second = await goLiveEmployee({ tenantId: "T", employeeName: "נועה" });
    expect(second.employee.id).toBe(first.employee.id);
    expect(second.created).toBe(false);
    expect(H.agents).toHaveLength(1);
    expect(H.agents[0].name).toBe("נועה");
    expect(H.perms).toHaveLength(2);
    expect(H.kbLinks).toHaveLength(2);
  });

  it("an employee the owner edited in the studio is LEFT AS IS on a second press, and reported", async () => {
    await goLiveEmployee({ tenantId: "T" });
    const a = H.agents[0];
    a.toneConfig = { ...a.toneConfig, brandVoice: "the owner's own words" };
    const before = JSON.stringify(a);
    const permsBefore = H.perms.length;
    const r = await goLiveEmployee({ tenantId: "T", employeeName: "Someone else" });
    expect(r.warnings).toEqual(["employee_customized"]);
    expect(JSON.stringify(H.agents[0])).toBe(before);
    expect(H.agents).toHaveLength(1);
    expect(H.perms).toHaveLength(permsBefore);
  });

  it("an unedited employee keeps being updated (the fingerprint follows each write)", async () => {
    await goLiveEmployee({ tenantId: "T" });
    const h1 = H.setting.get(EMPLOYEE_HASH_SETTING);
    const r = await goLiveEmployee({ tenantId: "T", employeeName: "נועה" });
    expect(r.warnings).not.toContain("employee_customized");
    expect(H.agents[0].name).toBe("נועה");
    expect(H.setting.get(EMPLOYEE_HASH_SETTING)).not.toBe(h1);
  });

  it("grants ONLY the platform's order tools the catalogue marks READ - never a write, never an unlisted read", async () => {
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.tools).toEqual({ platform: "shopify", granted: ["shopify.get_order", "shopify.track_shipment"] });
    expect(H.perms.map((p) => p.tenantToolId).sort()).toEqual(["t1", "t2"]);
  });

  it("an owner's explicit 'no' on a tool stays a no", async () => {
    H.perms.push({ id: "px", tenantId: "T", aiAgentId: "ag1", tenantToolId: "t1", isAllowed: false });
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(H.perms.find((p) => p.tenantToolId === "t1").isAllowed).toBe(false);
    expect(r.tools.granted).toEqual(["shopify.track_shipment"]);
  });

  it("an empty playbook routes every channel to the employee", async () => {
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(H.canvas.nodes.map((n: any) => n.type)).toEqual(["start", "route_target"]);
    expect(H.canvas.nodes[1].data).toEqual({ routeType: "agent", targetId: r.employee.id });
    expect(r.channels.every((c) => c.routed)).toBe(true);
  });

  it("an owner's customized playbook is LEFT AS IS, and the response says so", async () => {
    const custom = { nodes: [{ id: "start-1", type: "start" }, { id: "kw", type: "keyword_trigger" }, { id: "r", type: "route_target", data: { routeType: "human" } }] };
    H.canvas = JSON.parse(JSON.stringify(custom));
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(H.canvas).toEqual(custom);
    expect(r.warnings).toContain("playbook_customized");
    expect(r.channels.every((c) => !c.routed)).toBe(true);
  });

  it("an update without a name keeps the employee's name; a typed name renames; the default names only a new one", async () => {
    const first = await goLiveEmployee({ tenantId: "T", employeeName: "Dana" });
    expect(first.employee.name).toBe("Dana");
    const again = await goLiveEmployee({ tenantId: "T" });
    expect(again.employee).toMatchObject({ id: first.employee.id, name: "Dana" });
    expect(H.agents[0].name).toBe("Dana");
    expect((await goLiveEmployee({ tenantId: "T", employeeName: "Rona" })).employee.name).toBe("Rona");
  });

  it("no channels and no platform are warnings, not failures", async () => {
    H.accounts = []; H.integrations = [];
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.warnings).toEqual(["no_channels", "no_platform_connected"]);
    expect(r.tools).toEqual({ platform: null, granted: [] });
  });

  it("a website widget never seen on the site is waiting_for_install; WhatsApp is live", async () => {
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.channels.map((c) => [c.type, c.reach])).toEqual([["WEBCHAT", "waiting_for_install"], ["WHATSAPP", "live"]]);
    expect(r.warnings).not.toContain("no_reachable_channel");
  });

  it("WhatsApp, Instagram or email in ERROR or PENDING is waiting, not 'answering here'; CONNECTED is live", async () => {
    H.accounts = [
      { id: "w1", channel: "WHATSAPP", displayName: "WA", connectionStatus: "ERROR" },
      { id: "i1", channel: "INSTAGRAM", displayName: "IG", connectionStatus: "PENDING" },
      { id: "e1", channel: "EMAIL", displayName: "Mail", connectionStatus: "CONNECTED" },
    ];
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.channels.map((c) => [c.type, c.reach])).toEqual([["WHATSAPP", "waiting_for_install"], ["INSTAGRAM", "waiting_for_install"], ["EMAIL", "live"]]);
    H.accounts = H.accounts.slice(0, 2);
    expect((await goLiveEmployee({ tenantId: "T" })).warnings).toContain("no_reachable_channel");
  });

  it("ONLY a not-yet-installed widget: no_reachable_channel, never 'live on: website'", async () => {
    H.accounts = [{ id: "ca1", channel: "WEBCHAT", displayName: "Site", connectionStatus: "PENDING" }];
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.channels[0].reach).toBe("waiting_for_install");
    expect(r.warnings).toEqual(["no_reachable_channel"]);
  });

  it("a widget seen on the site is live", async () => {
    H.accounts = [{ id: "ca1", channel: "WEBCHAT", displayName: "Site", connectionStatus: "CONNECTED" }];
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.channels[0].reach).toBe("live");
    expect(r.warnings).toEqual([]);
  });

  it("Shopify chat is live only when enabled AND its app embed loaded this week", async () => {
    H.accounts = [
      { id: "s1", channel: "SHOPIFY_LIVE_CHAT", displayName: "A" },
      { id: "s2", channel: "SHOPIFY_LIVE_CHAT", displayName: "B" },
      { id: "s3", channel: "SHOPIFY_LIVE_CHAT", displayName: "C" },
    ];
    H.shops = [
      { channelId: "s1", status: "active", embedLive: true },
      { channelId: "s2", status: "active", embedLive: false },
      { channelId: "s3", status: "not_enabled", embedLive: true },
    ];
    const r = await goLiveEmployee({ tenantId: "T" });
    expect(r.channels.map((c) => c.reach)).toEqual(["live", "waiting_for_install", "waiting_for_install"]);
    H.shops = [];
    expect((await goLiveEmployee({ tenantId: "T" })).warnings).toContain("no_reachable_channel");
  });

  it("refuses before the scan finished: NOT_LEARNED, nothing created", async () => {
    H.discovery = { ...H.discovery, status: "SCANNING" };
    await expect(goLiveEmployee({ tenantId: "T" })).rejects.toMatchObject({ code: "NOT_LEARNED" });
    expect(H.agents).toEqual([]);
  });
});

describe("the suggested test question", () => {
  it("names the store's newest REAL order, read as the owner, in the site's language", async () => {
    const r = await goLiveEmployee({ tenantId: "T", actor: "u1" });
    expect(r.suggestedOrderQuestion).toBe("איפה ההזמנה שלי #1043?");
    expect(H.adapterCalls).toEqual([{
      tenantId: "T", toolFunctionName: "shopify.get_orders", args: { limit: 1, status: "any" },
      accessScope: "internal", actingFor: { userId: "u1", reason: "onboarding_test" },
    }]);
  });
  it("no platform, no order, or a failed read: null - never an invented order", async () => {
    H.adapterReply = { ok: true, result: { orders: [] } };
    expect((await goLiveEmployee({ tenantId: "T" })).suggestedOrderQuestion).toBeNull();
    H.adapterReply = { ok: false, reason: "token_expired" };
    expect((await goLiveEmployee({ tenantId: "T" })).suggestedOrderQuestion).toBeNull();
    H.integrations = [];
    H.adapterCalls = [];
    expect((await goLiveEmployee({ tenantId: "T" })).suggestedOrderQuestion).toBeNull();
    expect(H.adapterCalls).toEqual([]);
  });
});

describe("policy guidelines", () => {
  it("only stated terms are written; a policy with no summary is skipped", () => {
    expect(policyGuidelines([{ kind: "shipping", summary: "Ships fast.", terms: { shipping: { times: "2-3 days", freeOver: 300 } } }, { kind: "x", summary: "" }]))
      .toEqual(["Store policy (shipping): Ships fast. [shipping 2-3 days; free over 300]"]);
  });
});
