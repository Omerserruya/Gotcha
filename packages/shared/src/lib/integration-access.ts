/**
 * Which business systems an AI employee may use: a per-employee ALLOWLIST
 * (AIAgent.integrationAccess). A system connected later is off for every
 * employee until someone turns it on for them.
 *
 * Keys:
 *   - an integration's catalog slug ("hubspot", "shopify")
 *   - "custom:<id>" for a tenant-defined custom API tool or custom DB query
 *
 * Per-tool rows (AgentToolPermission) still decide WHICH tools of an allowed
 * system the employee gets; this list decides whether the system is reachable
 * at all. It is not tied to a connection, so it survives disconnect,
 * reconnect and tool provisioning (which re-creates per-tool rows).
 *
 * The ONE place the "allowed tools for this employee" query lives: the bot's
 * surface, the kernel's grants, skill fit and the dispatch gate all read it
 * from here instead of keeping their own copies.
 */
import { prisma } from "./prisma";

export const CUSTOM_ACCESS_PREFIX = "custom:";
export const customAccessKey = (id: string) => `${CUSTOM_ACCESS_PREFIX}${id}`;

/** The employee's allowlist. Empty for an unknown employee (nothing allowed). */
export async function loadIntegrationAccess(tenantId: string, aiAgentId: string): Promise<Set<string>> {
  const a = await prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { integrationAccess: true } });
  return new Set(Array.isArray(a?.integrationAccess) ? a!.integrationAccess : []);
}

/**
 * The AgentToolPermission filter for "this employee may call this tool now":
 * granted, enabled for the workspace, its system connected AND on the
 * employee's allowlist. `tenantTool` adds caller-specific conditions.
 */
export function agentGrantWhere(
  tenantId: string,
  aiAgentId: string,
  access: Set<string>,
  tenantTool: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId,
    aiAgentId,
    isAllowed: true,
    tenantTool: {
      ...tenantTool,
      isEnabled: true,
      tenantIntegration: { status: "CONNECTED", integration: { slug: { in: [...access].filter((k) => !k.startsWith(CUSTOM_ACCESS_PREFIX)) } } },
    },
  };
}

/**
 * `${integrationSlug}:${catalogToolSlug}` for every tool this employee may
 * call. With a mode, tools whose catalog entry excludes that mode are dropped
 * (a missing or malformed allowedModes permits all).
 */
export async function allowedIntegrationToolKeys(
  tenantId: string,
  aiAgentId: string,
  opts: { mode?: "AUTO" | "ASSIST" } = {},
): Promise<Set<string>> {
  const access = await loadIntegrationAccess(tenantId, aiAgentId);
  const rows = await prisma.agentToolPermission.findMany({
    where: agentGrantWhere(tenantId, aiAgentId, access) as any,
    select: {
      tenantTool: {
        select: {
          catalogTool: { select: { slug: true, allowedModes: true } },
          tenantIntegration: { select: { integration: { select: { slug: true } } } },
        },
      },
    },
  });
  const out = new Set<string>();
  for (const r of rows as any[]) {
    const integ = r.tenantTool?.tenantIntegration?.integration?.slug;
    const slug = r.tenantTool?.catalogTool?.slug;
    if (!integ || !slug || !access.has(integ)) continue;
    const am = r.tenantTool?.catalogTool?.allowedModes;
    if (opts.mode && Array.isArray(am) && !am.includes(opts.mode)) continue;
    out.add(`${integ}:${slug}`);
  }
  return out;
}

/**
 * The allowlist a new employee starts with when its creator does not choose:
 * every system the workspace has set up today (any connection state: one in
 * error today is still the workspace's system) and every custom tool. What is
 * connected after the employee exists stays off until turned on.
 */
export async function defaultIntegrationAccess(tenantId: string): Promise<string[]> {
  const [integrations, api, db] = await Promise.all([
    prisma.tenantIntegration.findMany({ where: { tenantId }, select: { integration: { select: { slug: true } } } }),
    prisma.customApiTool.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.customDbQueryTool.findMany({ where: { tenantId }, select: { id: true } }),
  ]);
  const keys = new Set<string>();
  for (const i of integrations as any[]) if (i.integration?.slug) keys.add(i.integration.slug);
  for (const c of [...api, ...db] as any[]) keys.add(customAccessKey(c.id));
  return [...keys].sort();
}

export interface IntegrationAccessChoice {
  key: string;
  kind: "integration" | "custom_api" | "custom_db";
  name: string;
  /** For an integration: the workspace's connection state; custom tools: "ACTIVE" | "INACTIVE". */
  status: string;
}

/** What the employee's allowlist can hold in this workspace (its systems and custom tools). */
export async function integrationAccessChoices(tenantId: string): Promise<IntegrationAccessChoice[]> {
  const [integrations, api, db] = await Promise.all([
    prisma.tenantIntegration.findMany({ where: { tenantId }, select: { status: true, integration: { select: { slug: true, name: true } } } }),
    prisma.customApiTool.findMany({ where: { tenantId }, select: { id: true, name: true, slug: true, isActive: true } }),
    prisma.customDbQueryTool.findMany({ where: { tenantId }, select: { id: true, name: true, slug: true, isActive: true } }),
  ]);
  const out: IntegrationAccessChoice[] = [];
  const seen = new Set<string>();
  for (const i of integrations as any[]) {
    const slug = i.integration?.slug;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ key: slug, kind: "integration", name: i.integration?.name || slug, status: String(i.status) });
  }
  for (const c of api as any[]) out.push({ key: customAccessKey(c.id), kind: "custom_api", name: c.name || c.slug, status: c.isActive ? "ACTIVE" : "INACTIVE" });
  for (const c of db as any[]) out.push({ key: customAccessKey(c.id), kind: "custom_db", name: c.name || c.slug, status: c.isActive ? "ACTIVE" : "INACTIVE" });
  return out;
}

/**
 * A client-sent allowlist, checked: every key must be a catalog integration
 * or one of this workspace's custom tools. Returns the clean, de-duplicated
 * list, or the first key that is neither.
 */
export async function validateIntegrationAccess(
  tenantId: string,
  raw: unknown,
): Promise<{ ok: true; keys: string[] } | { ok: false; invalid: string }> {
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || !k.trim())) return { ok: false, invalid: String(raw) };
  const keys = [...new Set((raw as string[]).map((k) => k.trim()))];
  const customIds = keys.filter((k) => k.startsWith(CUSTOM_ACCESS_PREFIX)).map((k) => k.slice(CUSTOM_ACCESS_PREFIX.length));
  const slugs = keys.filter((k) => !k.startsWith(CUSTOM_ACCESS_PREFIX));
  const [catalog, api, db] = await Promise.all([
    slugs.length ? prisma.integrationCatalog.findMany({ where: { slug: { in: slugs } }, select: { slug: true } }) : [],
    customIds.length ? prisma.customApiTool.findMany({ where: { tenantId, id: { in: customIds } }, select: { id: true } }) : [],
    customIds.length ? prisma.customDbQueryTool.findMany({ where: { tenantId, id: { in: customIds } }, select: { id: true } }) : [],
  ]);
  const known = new Set<string>([
    ...(catalog as any[]).map((c) => c.slug),
    ...[...(api as any[]), ...(db as any[])].map((c) => customAccessKey(c.id)),
  ]);
  const bad = keys.find((k) => !known.has(k));
  return bad ? { ok: false, invalid: bad } : { ok: true, keys: keys.sort() };
}
