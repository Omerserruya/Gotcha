/**
 * Onboarding v2 go-live: the first AI employee, hired properly (2026-10-23).
 *
 * Deterministic - no model call. The same field mapping the legacy generator
 * uses (buildAgentFields: identity, goals, tone, behaviour, the discovered
 * brand), plus what the old paths never applied: the employee's name, the
 * structured policy TERMS in its guidelines, every knowledge base, the store
 * platform's READ order tools, a department, and routing.
 *
 * Idempotent: the employee is remembered in the durable setting
 * "onboarding:employeeId", so pressing go-live again updates the same one.
 *
 * Routing is the FlowCanvas (the only thing live routing reads):
 *   - empty: start -> route to the employee (every channel);
 *   - one this function wrote before (its node ids): retarget, same shape;
 *   - anything else is the owner's playbook and is NOT touched; the response
 *     says so (playbook_customized) and reports where the employee answers.
 *
 * Sends nothing. Activating an employee and routing to it only changes who
 * answers the NEXT inbound message.
 */
import crypto from "crypto";
import { prisma, readDurableSetting, writeDurableSetting, defaultIntegrationAccess } from "@chatcenter/shared";
import { buildAgentFields, type BusinessProfileData, type DepartmentData } from "./agent-config-generator";
import { whereEmployeeAnswers } from "./employee-reach.service";
import { installOf } from "./website-widget.service";
import { logAudit } from "./audit.service";
import { executeAdapterTool } from "./connectors/integration-framework";

export const EMPLOYEE_SETTING = "onboarding:employeeId";
/** A fingerprint of the employee as go-live last wrote it: a change means the owner edited it. */
export const EMPLOYEE_HASH_SETTING = "onboarding:employeeHash";

/** The fields go-live writes, as a stable fingerprint. */
export function employeeFingerprint(a: Record<string, any>): string {
  const keys = ["name", "role", "departmentId", "identity", "goals", "goal", "successCriteria", "toneConfig", "behavioral", "persona", "customGuardrails", "status"];
  const canon = (v: any): any => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v ?? null);
  return crypto.createHash("sha256").update(JSON.stringify(keys.map((k) => canon(a[k])))).digest("hex");
}
const START_ID = "onboarding-start";
const ROUTE_ID = "onboarding-route";

/**
 * The order READ tools an onboarding employee gets, per platform. Explicit,
 * and granted only when the catalogue says the tool is category READ: a
 * refund or an order edit can never come in through here. (The role-based
 * reconcile list has no WooCommerce order tools at all, which is why this one
 * exists.)
 */
export const ORDER_READ_TOOLS: Record<string, string[]> = {
  shopify: [
    "get_order", "get_orders", "search_orders", "order_lookup", "find_latest_order", "get_customer_orders",
    "get_order_items", "get_shipment_status", "get_tracking_number", "get_tracking_url", "track_shipment",
    "find_delayed_order", "get_returns", "check_return_status", "get_refund_status",
  ],
  woocommerce: ["get_order", "list_orders", "list_customer_orders", "get_shipment_tracking", "list_refunds"],
};

/** A customer-visible order number in a tool result: Shopify "name" ("#1043"), Woo "number", or order_number. */
export function orderNumberIn(result: string): string | null {
  let data: any;
  try { data = JSON.parse(result); } catch { return null; }
  const seen = new Set<any>();
  const walk = (v: any, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 5 || seen.has(v)) return null;
    seen.add(v);
    if (typeof v.name === "string" && /^#?\d{2,}$/.test(v.name.trim())) return v.name.trim().replace(/^#/, "");
    if ((typeof v.number === "string" || typeof v.number === "number") && /^\d+$/.test(String(v.number))) return String(v.number);
    if ((typeof v.order_number === "string" || typeof v.order_number === "number") && /^\d+$/.test(String(v.order_number))) return String(v.order_number);
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      const n = walk(x, depth + 1);
      if (n) return n;
    }
    return null;
  };
  return walk(data, 0);
}

/** The newest order's tool call per platform: read-only, and Shopify's default is open orders only. */
const LATEST_ORDER: Record<string, { tool: string; args: Record<string, unknown> }> = {
  shopify: { tool: "shopify.get_orders", args: { limit: 1, status: "any" } },
  woocommerce: { tool: "woocommerce.list_orders", args: { per_page: 1 } },
};

/**
 * A test question about a REAL order: the store's newest order number, read
 * as the owner (the admin is the audited actor), phrased in the site's
 * language. Null when there is no platform or no order - never invented.
 */
export async function suggestedOrderQuestion(tenantId: string, platform: string | null, lang: string, actor: string | null): Promise<string | null> {
  const call = platform ? LATEST_ORDER[platform] : undefined;
  if (!call) return null;
  const r = await executeAdapterTool({
    tenantId,
    toolFunctionName: call.tool,
    args: call.args,
    accessScope: "internal",
    ...(actor ? { actingFor: { userId: actor, reason: "onboarding_test" } } : {}),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const n = orderNumberIn(typeof r.result === "string" ? r.result : JSON.stringify(r.result));
  if (!n) return null;
  return lang === "he" ? `איפה ההזמנה שלי #${n}?` : `Where is my order #${n}?`;
}

export class GoLiveRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = "GoLiveRefused"; }
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** One guideline line per policy, with its terms - so the rule is in the prompt, not only in retrieval. */
export function policyGuidelines(policies: any[]): string[] {
  const out: string[] = [];
  for (const p of Array.isArray(policies) ? policies : []) {
    if (!p || typeof p.summary !== "string" || !p.summary.trim()) continue;
    const t = obj(p.terms);
    const facts: string[] = [];
    if (typeof t.windowDays === "number") facts.push(`window ${t.windowDays} days`);
    if (t.exchange?.allowed === true) facts.push(`exchange allowed${t.exchange.how ? ` (${t.exchange.how})` : ""}`);
    if (t.exchange?.allowed === false) facts.push("no exchanges");
    if (t.shipping?.times) facts.push(`shipping ${t.shipping.times}`);
    if (t.shipping?.costs) facts.push(`cost ${t.shipping.costs}`);
    if (typeof t.shipping?.freeOver === "number") facts.push(`free over ${t.shipping.freeOver}`);
    if (t.refund?.method) facts.push(`refund by ${t.refund.method}`);
    if (typeof t.refund?.days === "number") facts.push(`refund within ${t.refund.days} days`);
    if (typeof t.warranty?.months === "number") facts.push(`warranty ${t.warranty.months} months`);
    out.push(`Store policy (${p.kind}): ${p.summary.trim()}${facts.length ? ` [${facts.join("; ")}]` : ""}`);
  }
  return out.slice(0, 10);
}

/**
 * "waiting_for_install": the channel exists but no customer can write there
 * yet - website code never seen on the site, or a Shopify app embed that is
 * off, uninstalled or silent for a week. Every other active account is "live".
 */
export type ChannelReach = "live" | "waiting_for_install";
export interface GoLiveChannel { id: string; type: string; displayName: string; routed: boolean; reach: ChannelReach }

/** The active channels, where the employee answers, and whether a customer can reach each. */
async function channelsOf(tenantId: string, agentId: string): Promise<GoLiveChannel[]> {
  const reach = await whereEmployeeAnswers(tenantId, agentId).catch(() => []);
  const answered = new Set(reach.filter((r: any) => r.reach === "always").map((r: any) => r.channel));
  const accounts = await prisma.channelAccount.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, channel: true, displayName: true, connectionStatus: true },
  });
  const liveShops = accounts.some((a) => String(a.channel) === "SHOPIFY_LIVE_CHAT")
    ? new Set((await installOf(tenantId).catch(() => null))?.shopify.filter((s) => s.status === "active" && s.embedLive).map((s) => s.channelId) ?? [])
    : new Set<string>();
  return accounts.map((a) => {
    const type = String(a.channel);
    const live = type === "WEBCHAT" ? String(a.connectionStatus) === "CONNECTED"
      : type === "SHOPIFY_LIVE_CHAT" ? liveShops.has(a.id)
      : true;
    return { id: a.id, type, displayName: a.displayName, routed: answered.has(type), reach: live ? "live" : "waiting_for_install" };
  });
}

/** no_channels: none at all; no_reachable_channel: some, but none a customer can write to yet. */
function channelWarnings(channels: GoLiveChannel[]): string[] {
  if (!channels.length) return ["no_channels"];
  return channels.some((c) => c.reach === "live") ? [] : ["no_reachable_channel"];
}

export interface GoLiveResult {
  employee: { id: string; name: string; status: "ACTIVE" };
  created: boolean;
  channels: GoLiveChannel[];
  knowledgeBases: number;
  policiesApplied: number;
  tools: { platform: string | null; granted: string[] };
  warnings: string[];
  /** A test question about the store's newest real order, or null. */
  suggestedOrderQuestion: string | null;
}

export async function goLiveEmployee(input: { tenantId: string; actor?: string | null; employeeName?: string | null }): Promise<GoLiveResult> {
  const { tenantId } = input;
  const [tenant, discovery, profile] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    prisma.businessDiscovery.findUnique({
      where: { tenantId },
      select: { status: true, business: true, brand: true, knowledge: true, recommendation: true, technology: true, primaryGoal: true },
    }),
    prisma.businessProfile.findUnique({ where: { tenantId } }).catch(() => null),
  ]);
  if (!tenant) throw new GoLiveRefused("TENANT_NOT_FOUND");
  if (!discovery || discovery.status !== "COMPLETE") throw new GoLiveRefused("NOT_LEARNED");

  const business = obj(discovery.business);
  const structured = obj(obj(discovery.knowledge).structured);
  const lang = typeof structured.lang === "string" ? structured.lang : "he";

  // ── department: the first active one, or "Customer service" ──
  let department = await prisma.department.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: "asc" } });
  if (!department) {
    department = await prisma.department.create({
      data: { tenantId, name: lang === "he" ? "שירות לקוחות" : "Customer service", autoRepliesEnabled: true },
    });
  }

  // ── the deterministic fields, from the profile if there is one, else what the scan learned ──
  const profileData: BusinessProfileData = profile
    ? { organizationName: profile.organizationName, industry: profile.industry, businessDescription: profile.businessDescription, businessPriority: profile.businessPriority }
    : {
        organizationName: business.name || tenant.name,
        industry: business.industry || "retail",
        businessDescription: business.summary || null,
        businessPriority: "FAST_RESPONSE",
      } as BusinessProfileData;
  const deptData: DepartmentData = {
    id: department.id, name: department.name, slaTarget: department.slaTarget,
    autoGreetingEnabled: department.autoGreetingEnabled, autoRepliesEnabled: department.autoRepliesEnabled,
    aiSuggestionsEnabled: department.aiSuggestionsEnabled, escalateOnSlaBreach: department.escalateOnSlaBreach,
    autoCloseMinutes: department.autoCloseMinutes,
  };
  const fields: any = await buildAgentFields({ tenantId, profileData, deptData, primaryGoal: discovery.primaryGoal });
  const policies = policyGuidelines(structured.policies);
  if (policies.length) {
    fields.identity = { ...fields.identity, representationGuidelines: [...(fields.identity?.representationGuidelines ?? []), ...policies] };
  }

  // ── the employee: the one go-live made before, or a new one ──
  const remembered = await readDurableSetting(tenantId, EMPLOYEE_SETTING);
  const existing = remembered
    ? await prisma.aIAgent.findFirst({
        where: { id: remembered, tenantId },
        select: {
          id: true, name: true, role: true, departmentId: true, identity: true, goals: true, goal: true, successCriteria: true,
          toneConfig: true, behavioral: true, persona: true, customGuardrails: true, status: true,
        },
      })
    : null;
  // Edited in the studio since go-live wrote it: the owner's employee now, like
  // a customized playbook - left exactly as it is, and reported.
  const lastWritten = existing ? await readDurableSetting(tenantId, EMPLOYEE_HASH_SETTING) : null;
  if (existing && lastWritten && employeeFingerprint(existing) !== lastWritten) {
    return customizedResult(tenantId, existing.id, existing.name, input.actor ?? null);
  }
  // A name the owner typed wins; an update without one keeps the employee's
  // current name; the recommendation or the default only names a new one.
  const name = (input.employeeName?.trim() || existing?.name || obj(discovery.recommendation).employeeName || (lang === "he" ? "נועה" : "Noa")).slice(0, 40);
  const data = {
    ...fields,
    name,
    role: "customer_support",
    departmentId: department.id,
    integrationAccess: await defaultIntegrationAccess(tenantId),
    status: "ACTIVE" as const,
    builderStep: null,
  };
  const FINGERPRINTED = {
    id: true, name: true, role: true, departmentId: true, identity: true, goals: true, goal: true, successCriteria: true,
    toneConfig: true, behavioral: true, persona: true, customGuardrails: true, status: true,
  } as const;
  const agent = existing
    ? await prisma.aIAgent.update({ where: { id: existing.id }, data, select: FINGERPRINTED })
    : await prisma.aIAgent.create({ data: { tenantId, ...data }, select: FINGERPRINTED });
  if (!existing) await writeDurableSetting(tenantId, EMPLOYEE_SETTING, agent.id, input.actor ?? undefined);
  await writeDurableSetting(tenantId, EMPLOYEE_HASH_SETTING, employeeFingerprint(agent), input.actor ?? undefined);

  // ── every knowledge base ──
  const kbs = await prisma.knowledgeBase.findMany({ where: { tenantId, isActive: true }, select: { id: true } });
  for (const kb of kbs) {
    await prisma.aIAgentKnowledge.upsert({
      where: { aiAgentId_knowledgeBaseId: { aiAgentId: agent.id, knowledgeBaseId: kb.id } },
      create: { aiAgentId: agent.id, knowledgeBaseId: kb.id },
      update: {},
    });
  }

  // ── the platform's order READ tools ──
  const tools = await grantOrderReadTools(tenantId, agent.id);

  // ── routing ──
  const routing = await routeToEmployee(tenantId, agent.id, input.actor ?? null);

  const channels = await channelsOf(tenantId, agent.id);

  const warnings: string[] = channelWarnings(channels);
  if (!tools.platform) warnings.push("no_platform_connected");
  if (routing === "customized") warnings.push("playbook_customized");

  await logAudit({
    tenantId,
    actor: { type: input.actor ? "user" : "system", id: input.actor ?? undefined },
    action: "onboarding.go_live",
    target: { type: "ai_agent", id: agent.id },
    metadata: { created: !existing, knowledgeBases: kbs.length, policies: policies.length, tools: tools.granted, routing, channels: channels.length },
  });

  return {
    employee: { id: agent.id, name: agent.name, status: "ACTIVE" },
    created: !existing,
    channels,
    knowledgeBases: kbs.length,
    policiesApplied: policies.length,
    tools,
    warnings,
    suggestedOrderQuestion: await suggestedOrderQuestion(tenantId, tools.platform, lang, input.actor ?? null),
  };
}

/** The owner's edited employee: nothing about it changes; report where it answers. */
async function customizedResult(tenantId: string, agentId: string, name: string, actor: string | null): Promise<GoLiveResult> {
  const channels = await channelsOf(tenantId, agentId);
  await logAudit({
    tenantId,
    actor: { type: actor ? "user" : "system", id: actor ?? undefined },
    action: "onboarding.go_live",
    target: { type: "ai_agent", id: agentId },
    metadata: { created: false, left: "employee_customized" },
  });
  return {
    employee: { id: agentId, name, status: "ACTIVE" },
    created: false,
    channels,
    knowledgeBases: 0,
    policiesApplied: 0,
    tools: { platform: null, granted: [] },
    warnings: ["employee_customized", ...channelWarnings(channels)],
    suggestedOrderQuestion: null,
  };
}

/** Grant the connected platform's order READ tools (category READ only), read-then-create. */
export async function grantOrderReadTools(tenantId: string, agentId: string): Promise<{ platform: string | null; granted: string[] }> {
  const connected = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED", integration: { slug: { in: Object.keys(ORDER_READ_TOOLS) } } },
    select: { id: true, integration: { select: { slug: true } } },
  });
  if (!connected.length) return { platform: null, granted: [] };
  const granted: string[] = [];
  let platform: string | null = null;
  for (const ti of connected) {
    const slug = ti.integration.slug;
    platform ??= slug;
    const tools = await prisma.tenantTool.findMany({
      where: { tenantId, tenantIntegrationId: ti.id, isEnabled: true, catalogTool: { slug: { in: ORDER_READ_TOOLS[slug] ?? [] }, category: "READ" } },
      select: { id: true, catalogTool: { select: { slug: true } } },
    });
    for (const t of tools) {
      // The unique key cannot see aiAgentId, so look before creating.
      const has = await prisma.agentToolPermission.findFirst({ where: { tenantId, aiAgentId: agentId, tenantToolId: t.id }, select: { id: true, isAllowed: true } });
      if (!has) await prisma.agentToolPermission.create({ data: { tenantId, aiAgentId: agentId, tenantToolId: t.id, isAllowed: true } });
      // An explicit "no" an owner set stays a no.
      if (!has || has.isAllowed) granted.push(`${slug}.${t.catalogTool.slug}`);
    }
  }
  return { platform, granted: granted.sort() };
}

/** "routed": the canvas now answers with this employee; "customized": the owner's playbook, left alone. */
export async function routeToEmployee(tenantId: string, agentId: string, actor: string | null): Promise<"routed" | "customized"> {
  const canvas = await (prisma as any).flowCanvas.findUnique({ where: { tenantId }, select: { nodes: true } });
  const nodes: any[] = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const ours = nodes.length === 2 && nodes.some((n) => n.id === START_ID) && nodes.some((n) => n.id === ROUTE_ID);
  if (nodes.length && !ours) return "customized";
  const start = { id: START_ID, type: "start", data: { trigger: "message_received" }, position: { x: 400, y: 100 } };
  const route = { id: ROUTE_ID, type: "route_target", data: { routeType: "agent", targetId: agentId }, position: { x: 750, y: 100 } };
  const data = { nodes: [start, route], edges: [{ id: `e-${START_ID}-${ROUTE_ID}`, source: START_ID, target: ROUTE_ID }], updatedBy: actor };
  await (prisma as any).flowCanvas.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  return "routed";
}
