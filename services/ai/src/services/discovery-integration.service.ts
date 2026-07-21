/**
 * Per-turn Discovery integration for the autonomous bot.
 *
 * Wires the authoritative Discovery State (packages/shared) into the AI turn:
 * reuse the EXISTING extractor (intelligence-live-extract) to propose facts,
 * persist them to the session, compute readiness deterministically, and return
 * a compact snapshot + the next-action decision the reply loop enforces.
 *
 * This is the hybrid seam: persistent authoritative state (shared) +
 * per-turn extraction/injection/orchestration (AI service). It does NOT talk
 * to the model itself beyond the extractor; the caller injects `snapshot` into
 * prompt BLOCK 5 and honors `decision`.
 */
import {
  getOrCreateActiveSession,
  applyExtractedFacts,
  markAnswered,
  computeReadiness,
  buildDiscoverySnapshot,
  getDiscoveryProfile,
  recordActionAttempt,
  type ProposedFact,
  type DiscoveryProfile,
} from "@chatcenter/shared";
import { extractFieldsLive } from "./intelligence-live-extract.service";
import { prisma } from "@chatcenter/shared";
import { normalizeShopifyProducts, type ProductSearchEnvelope } from "./product-search.service";

/** Product-search tool names this typed path covers (scoped - NOT generic). */
export function isProductSearchTool(toolName: string | undefined): boolean {
  return !!toolName && /(^|\.)(search_products|get_product)$/.test(toolName);
}

/** Parse a budget fact (`"700 USD"`, `700`, or `{target,currency}`) → typed budget. */
function parseBudget(v: unknown): { target: number; currency: string } | undefined {
  if (v && typeof v === "object" && "target" in (v as any)) {
    const t = Number((v as any).target);
    if (Number.isFinite(t)) return { target: t, currency: String((v as any).currency ?? "USD") };
  }
  const s = String(v ?? "");
  const num = s.match(/\d[\d.,]*/);
  if (!num) return undefined;
  const cur = /ILS|₪|שקל/i.test(s) ? "ILS" : /EUR|€/i.test(s) ? "EUR" : "USD";
  const t = Number(num[0].replace(/,/g, ""));
  return Number.isFinite(t) ? { target: t, currency: cur } : undefined;
}

/**
 * Build the canonical typed ProductSearchEnvelope from a raw Shopify search
 * result. Isolated to the product-recommendation flow. Reads shopDomain from
 * the tenant's Shopify connection (never model-supplied) and budget from the
 * active discovery session. Returns null if not a product tool / no data.
 */
export async function groundProductSearchResult(opts: {
  tenantId: string;
  conversationId: string;
  toolName: string;
  rawContent: string;
  provider?: boolean;
}): Promise<ProductSearchEnvelope | null> {
  try {
    if (!isProductSearchTool(opts.toolName)) return null;
    let parsed: any = opts.rawContent;
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return null; } }
    // Provider failure/denied → an ERROR envelope (never no-results).
    if (parsed && parsed.ok === false) {
      return { provider: "shopify", tool: "shopify_product_search", status: "error", candidates: [], appliedFilters: [], unavailableFilters: [], safeModelSummary: "" };
    }
    let products: any = parsed;
    if (products && typeof products === "object" && "result" in products) products = products.result;
    if (products && !Array.isArray(products)) products = [products]; // get_product → single
    if (!Array.isArray(products)) products = [];

    const conn = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId: opts.tenantId, integration: { slug: "shopify" } },
      select: { config: true },
    });
    const shopDomain = (conn?.config as any)?.shopDomain;
    if (!shopDomain) return null;

    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({ tenantId: opts.tenantId, conversationId: opts.conversationId, goalKey: profile.goalKey });
    const facts = await (await import("@chatcenter/shared")).activeFacts(session.id);
    const budget = parseBudget(facts.get("budget")?.valueJson);
    const requestedFilters = ["query", ...(budget ? ["budget"] : []),
      ...(facts.has("preferred_length_cm") ? ["length"] : []),
      ...(facts.has("flex") ? ["flex"] : []),
      ...(facts.has("riding_style") ? ["riding_style"] : []),
    ];
    return normalizeShopifyProducts(products, { shopDomain, budget, requestedFilters });
  } catch (err: any) {
    console.warn("[discovery] product envelope build failed (non-fatal):", err?.message);
    return null;
  }
}

export type DiscoveryDecision =
  | { kind: "collect" }                    // still missing required info - ask ONE
  | { kind: "execute"; tool: string }      // ready AND tool available - force the search
  | { kind: "blocked_no_tool"; tool: string }; // ready but tool not in surface - honest handoff

export interface DiscoveryTurnResult {
  active: boolean;
  goalKey?: string;
  snapshot?: string;
  decision?: DiscoveryDecision;
  writtenFacts?: string[];
}

/** Product-shopping signal: the store search tool is offered this turn, and the
 * conversation is a sales/product context (role or an already-collected
 * category fact). Kept conservative so non-shopping chats are unaffected. */
export function productDiscoveryApplies(opts: {
  role: string | null | undefined;
  availableToolNames: string[];
}): boolean {
  const salesish = ["sales", "sdr", "customer_success"].includes(String(opts.role || "").toLowerCase());
  const hasProductTool = opts.availableToolNames.some(
    (t) => t === "shopify.search_products" || t === "search_products" || t.endsWith(".search_products"),
  );
  // Applies when this is a sales-type employee. Whether the store tool is
  // available only changes execute vs honest-blocker, not whether we track.
  return salesish || hasProductTool;
}

/** Is the product-search tool actually in this turn's offered surface? */
export function productToolAvailable(availableToolNames: string[]): { available: boolean; tool: string } {
  const tool = availableToolNames.find(
    (t) => t === "shopify.search_products" || t === "search_products" || t.endsWith(".search_products"),
  );
  return { available: !!tool, tool: tool || "shopify.search_products" };
}

/** Map extractor output → typed ProposedFacts (all customer_explicit; the
 * extractor only emits what was stated/implied, with evidence + confidence). */
function toProposedFacts(
  extracted: Array<{ key: string; value: unknown; confidence?: number | null }>,
  sourceMessageId?: string | null,
): ProposedFact[] {
  return extracted.map((e) => ({
    key: e.key,
    value: e.value,
    source: "customer_explicit",
    confidence: e.confidence ?? undefined,
    sourceMessageId: sourceMessageId ?? null,
  }));
}

/**
 * Run the discovery pass for this turn. Safe/no-op when not applicable or on
 * any error (returns {active:false}); never throws into the bot turn.
 */
export async function runProductDiscoveryTurn(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  role: string | null | undefined;
  availableToolNames: string[];
  incomingMessageId?: string | null;
}): Promise<DiscoveryTurnResult> {
  try {
    if (!productDiscoveryApplies({ role: opts.role, availableToolNames: opts.availableToolNames })) {
      return { active: false };
    }
    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: profile.goalKey,
      aiAgentId: opts.aiAgentId,
    });

    // Reuse the existing extractor - NO new framework. Feed it the profile's
    // fact specs (key + description + enum hints).
    const specs = profile.facts.map((f) => ({
      key: f.key,
      description: f.description,
      ...(f.enumValues ? { examples: f.enumValues } : {}),
    }));
    const extracted = await extractFieldsLive({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      fields: specs as any,
    }).catch(() => []);

    const proposed = toProposedFacts(extracted as any, opts.incomingMessageId);
    const { written } = await applyExtractedFacts({ session, profile, facts: proposed });
    if (written.length) await markAnswered({ session, answeredKeys: written, answeredMessageId: opts.incomingMessageId });

    const readiness = await computeReadiness(session, profile);
    const snapshot = await buildDiscoverySnapshot(session, profile);

    let decision: DiscoveryDecision;
    if (!readiness.ready) {
      decision = { kind: "collect" };
    } else {
      const { available, tool } = productToolAvailable(opts.availableToolNames);
      decision = available ? { kind: "execute", tool } : { kind: "blocked_no_tool", tool };
    }
    return { active: true, goalKey: profile.goalKey, snapshot, decision, writtenFacts: written };
  } catch (err: any) {
    console.warn("[discovery] turn failed (non-fatal):", err?.message);
    return { active: false };
  }
}

/** Extract Shopify product ids from a tool result (typed or JSON-stringified). */
function productIdsFrom(result: unknown): string[] {
  let arr: any = result;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { return []; } }
  if (arr && typeof arr === "object" && "result" in arr) arr = (arr as any).result;
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => (p && p.id != null ? String(p.id) : null)).filter((x): x is string => !!x);
}

/**
 * Record the outcome of a product search this turn (spec item 9: search
 * attempts + displayed results). Scans the turn's toolCallLog for a
 * search_products call and writes a DiscoveryActionAttempt so re-shows can be
 * deduped and the discovery history is auditable. Non-fatal.
 */
export async function recordDiscoverySearchOutcome(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  toolCallLog: Array<{ tool?: string; args?: unknown; result?: unknown; decision?: string }>;
}): Promise<void> {
  try {
    const call = opts.toolCallLog.find(
      (t) => typeof t.tool === "string" && /(^|\.)search_products$/.test(t.tool),
    );
    if (!call) return;
    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: profile.goalKey,
      aiAgentId: opts.aiAgentId,
    });
    const ids = productIdsFrom(call.result);
    await recordActionAttempt({
      session,
      actionKey: "product_search",
      criteria: call.args ?? {},
      toolName: call.tool,
      resultStatus: call.decision === "denied" ? "blocked" : ids.length ? "succeeded" : "no_results",
      resultRefs: ids.length ? { productIds: ids } : null,
      shownResourceIds: ids,
    });
  } catch (err: any) {
    console.warn("[discovery] action-attempt record failed (non-fatal):", err?.message);
  }
}
