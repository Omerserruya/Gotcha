/**
 * The ONE human label for a tool, wherever Studio shows it: the tool picker
 * (/api/business-skills/tools) and each step's tools in a skill.
 *
 *   provider       the integration slug ("woocommerce"), for the logo; null
 *                  for GOTCHA's own tools
 *   providerLabel  the catalog's provider name ("WooCommerce", "HubSpot"),
 *                  never a case-folded slug; null for GOTCHA's own tools
 *   actionLabel    the action in sentence case ("Get order"); GOTCHA's own
 *                  tools are translated (shared toolDisplayName)
 *
 * The screen renders "WooCommerce · Get order" from these; it never maps a
 * tool id by hand.
 */
import { prisma } from "@chatcenter/shared";
import { toolDisplayName, humanizeToolName } from "@chatcenter/shared/src/lib/tool-display-names";

export type Locale = "en" | "he";

export interface ToolLabel {
  provider: string | null;
  providerLabel: string | null;
  actionLabel: string;
}

/** "woocommerce.get_order" → "woocommerce"; a system tool has no provider. */
export function providerOf(name: string): string | null {
  const i = String(name || "").indexOf(".");
  return i > 0 ? name.slice(0, i) : null;
}

/**
 * Pure. `catalogName` is the catalog's own action name ("Get Order") when
 * known; `providerName` the catalog's provider name.
 */
export function labelTool(name: string, catalogName: string | null | undefined, providerName: string | null | undefined, locale: Locale = "en"): ToolLabel {
  const provider = providerOf(name);
  const shown = toolDisplayName(name, catalogName ?? null, locale);
  // Provider-written names arrive in Title Case ("Get Order"); a step chip
  // reads them in sentence case like GOTCHA's own. A name with a dot in it
  // would be split by humanizeToolName, so it stays as written.
  const actionLabel = provider && !shown.includes(".") ? humanizeToolName(shown) : shown;
  return {
    provider,
    providerLabel: provider ? (providerName || humanizeToolName(provider)) : null,
    actionLabel,
  };
}

/** Labels for these tool names, from the integration catalog. */
export async function toolLabelsFor(names: string[], locale: Locale = "en"): Promise<Map<string, ToolLabel>> {
  const unique = [...new Set(names.filter(Boolean))];
  const providers = [...new Set(unique.map(providerOf).filter((p): p is string => !!p))];
  const [catalogs, tools] = providers.length
    ? await Promise.all([
        prisma.integrationCatalog.findMany({ where: { slug: { in: providers } }, select: { slug: true, name: true } }),
        prisma.catalogTool.findMany({
          where: { integration: { slug: { in: providers } } },
          select: { slug: true, name: true, integration: { select: { slug: true } } },
        }),
      ])
    : [[], []];
  const providerName = new Map((catalogs as any[]).map((c) => [c.slug as string, c.name as string]));
  const toolName = new Map((tools as any[]).map((t) => [`${t.integration?.slug}.${t.slug}`, t.name as string]));
  return new Map(unique.map((n) => [n, labelTool(n, toolName.get(n), providerName.get(providerOf(n) ?? ""), locale)]));
}

/** The request's locale: ?locale= first, then Accept-Language; English otherwise. */
export function localeOf(req: { query: any; headers: any }): Locale {
  const q = typeof req.query?.locale === "string" ? req.query.locale : undefined;
  const h = req.headers?.["accept-language"] as string | undefined;
  return String(q || h || "en").toLowerCase().startsWith("he") ? "he" : "en";
}

/**
 * A skill as Studio shows it: each step gains `toolDetails`, one entry per
 * tool in order. Read-only: a PUT that sends it back is ignored, because the
 * skill's input keeps only the step fields it knows.
 */
export async function withToolDetails<T extends { steps?: unknown }>(skills: T[], locale: Locale = "en"): Promise<T[]> {
  const stepsOf = (s: T): any[] => (Array.isArray(s.steps) ? (s.steps as any[]) : []);
  const names = skills.flatMap((s) => stepsOf(s).flatMap((st) => (Array.isArray(st?.tools) ? st.tools : [])));
  const labels = names.length ? await toolLabelsFor(names, locale) : new Map<string, ToolLabel>();
  return skills.map((s) => ({
    ...s,
    steps: stepsOf(s).map((st) => ({
      ...st,
      toolDetails: (Array.isArray(st?.tools) ? st.tools : []).map((n: string) => ({ name: n, ...(labels.get(n) ?? labelTool(n, null, null, locale)) })),
    })),
  }));
}
