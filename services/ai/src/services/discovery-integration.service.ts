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
import { getCatalogFacets, profileForStore } from "./shopify-facets.service";
// STATIC import on purpose. A dynamic `await import(...)` of this module
// resolved to a second instance whose adapter REGISTRY was empty - the
// adapters register as an import side-effect of the connectors barrel, which
// only the startup instance has run - so every call came back
// `unknown_provider:shopify`. Same specifier as every other caller, same
// instance, populated registry.
import { executeAdapterTool } from "./connectors/integration-framework";

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
 * The store's own currency, cached on the integration config.
 *
 * Shopify quotes variant prices as bare numbers with no currency attached, so
 * without this the display currency was taken from whatever the SHOPPER said
 * ("עד 800 שקל" → every price labelled ILS on a USD catalog). Read once from
 * `/shop.json` and remembered, because it changes about never and every
 * product card needs it.
 *
 * Returns undefined if the shop cannot be read. Callers then show the bare
 * number: an unlabelled price is merely ambiguous, a mislabelled one is false.
 */
async function resolveShopCurrency(tenantId: string, config: any): Promise<string | undefined> {
  const cached = config?.shopCurrency;
  if (typeof cached === "string" && cached.length === 3) return cached;
  try {
    const res = await executeAdapterTool({
      tenantId,
      toolFunctionName: "shopify.get_shop",
      args: {},
      accessScope: "internal",
    });
    if (!res.ok) {
      console.warn(`[discovery] shop currency: get_shop denied (${res.reason})`);
      return undefined;
    }
    const currency = (res.result as any)?.currency;
    if (typeof currency !== "string" || currency.length !== 3) {
      console.warn(`[discovery] shop currency: unusable value ${JSON.stringify(currency)}`);
      return undefined;
    }
    // Scope the write by PRIMARY KEY. `updateMany` does not accept a nested
    // relation filter, so `{ integration: { slug } }` would throw here rather
    // than match nothing - and the throw is silent behind the catch below.
    const row = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId, integration: { slug: "shopify" } },
      select: { id: true },
    });
    if (row) {
      await (prisma as any).tenantIntegration.update({
        where: { id: row.id },
        data: { config: { ...(config ?? {}), shopCurrency: currency } },
      });
    }
    return currency;
  } catch (err: any) {
    console.warn("[discovery] shop currency lookup failed (non-fatal):", err?.message);
    return undefined;
  }
}

/**
 * Fill a product search's arguments from what the conversation already
 * established, before the call leaves for Shopify.
 *
 * The model is asked to pass `price_max` when a budget is known, and mostly
 * does. This makes it not matter. The failure this closes is not a model that
 * forgets - it is a model that REMEMBERS out loud and acts anyway: live on the
 * Urban Supply store the bot wrote "אחפש עכשיו רק בתוך הטווח של 600$" and then
 * issued a search with no bound at all, four turns running. A promise about
 * the search has to be kept by the search.
 *
 * Only ever NARROWS. An explicit argument from the model is left alone - it
 * may know something this turn that the stored facts do not - and a budget in
 * a currency the store does not price in is dropped rather than compared,
 * exactly as the envelope does downstream.
 */
export async function enrichProductSearchArgs(opts: {
  tenantId: string;
  conversationId: string;
  toolName: string;
  args: Record<string, any>;
}): Promise<Record<string, any>> {
  try {
    if (!isProductSearchTool(opts.toolName)) return opts.args;
    if (opts.args?.price_max !== undefined) return opts.args;

    const conn = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId: opts.tenantId, integration: { slug: "shopify" } },
      select: { config: true },
    });
    if (!conn) return opts.args;

    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: profile.goalKey,
    });
    const facts = await (await import("@chatcenter/shared")).activeFacts(session.id);
    const budget = parseBudget(facts.get("budget")?.valueJson);
    if (!budget) return opts.args;

    const shopCurrency = await resolveShopCurrency(opts.tenantId, conn?.config);
    if (shopCurrency && budget.currency !== shopCurrency) {
      console.log(
        `[discovery] budget ${budget.currency} vs shop ${shopCurrency} - not passing price_max conv=${opts.conversationId}`,
      );
      return opts.args;
    }

    console.log(`[discovery] applying price_max=${budget.target} conv=${opts.conversationId}`);
    return { ...opts.args, price_max: budget.target };
  } catch (err: any) {
    console.warn("[discovery] search arg enrichment failed (non-fatal):", err?.message);
    return opts.args;
  }
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
    const shopCurrency = await resolveShopCurrency(opts.tenantId, conn?.config);

    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({ tenantId: opts.tenantId, conversationId: opts.conversationId, goalKey: profile.goalKey });
    const facts = await (await import("@chatcenter/shared")).activeFacts(session.id);
    const budget = parseBudget(facts.get("budget")?.valueJson);
    const requestedFilters = ["query", ...(budget ? ["budget"] : []),
      ...(facts.has("preferred_length_cm") ? ["length"] : []),
      ...(facts.has("flex") ? ["flex"] : []),
      ...(facts.has("riding_style") ? ["riding_style"] : []),
    ];
    return normalizeShopifyProducts(products, { shopDomain, budget, requestedFilters, shopCurrency });
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
    // The profile, adapted to the store actually connected. The static one
    // demands riding style and flex; a catalogue that records neither turns
    // those into questions that gate the search and then filter nothing.
    const profile = profileForStore(
      getDiscoveryProfile("product_recommendation") as DiscoveryProfile,
      await getCatalogFacets(opts.tenantId),
    );
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
      // Readiness is STICKY - once the session has enough facts it is ready on
      // every later turn, forever. The caller turns `execute` into a hard
      // OpenAI toolChoice, so left alone this pins the conversation to
      // `search_products` permanently: a shopper who asked about snowboards on
      // Tuesday and asks "איפה המשלוח שלי?" on Wednesday gets a product
      // catalogue, because the model was never allowed to answer the question
      // it was actually asked.
      //
      // The forced search is worth exactly one turn: the moment we first have
      // enough to search. After a search has run for this session the model
      // keeps the tool and the snapshot, and chooses for itself.
      const alreadySearched = await (prisma as any).discoveryActionAttempt.count({
        where: { sessionId: session.id, actionKey: "product_search" },
      }).catch(() => 0);
      const { available, tool } = productToolAvailable(opts.availableToolNames);
      decision = alreadySearched > 0
        ? { kind: "collect" }
        : available
          ? { kind: "execute", tool }
          : { kind: "blocked_no_tool", tool };
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
/** True for the cross-sell tool, whatever provider prefix it carries. */
export function isComplementaryTool(toolName: string | undefined): boolean {
  return !!toolName && /(^|\.)complementary_products$/.test(toolName);
}

/**
 * May we offer accessories for this product, right now?
 *
 * The rule the owner asked for is "only after they have settled on the main
 * thing", and half of that is checkable: a product the customer has never been
 * SHOWN cannot be a product they have chosen. `shownResourceIds` is already
 * written on every search, so the anchor is verified against the conversation's
 * own history rather than trusted from the model - which also means a
 * hallucinated product id can never become an upsell.
 *
 * The other half - whether "אני אקח את זה" was actually said - stays with the
 * model, guided by the tool's own usage note. This gate does not try to read
 * intent; it removes the case where there is provably no choice to build on.
 */
export async function complementaryAnchorAllowed(opts: {
  tenantId: string;
  conversationId: string;
  productId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const wanted = String(opts.productId || "").replace(/^gid:\/\/shopify\/Product\//, "");
    if (!wanted) return { ok: false, reason: "complementary_products needs the product_id of the product the customer chose." };

    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: profile.goalKey,
    });
    const attempts = await (prisma as any).discoveryActionAttempt.findMany({
      where: { sessionId: session.id },
      select: { shownResourceIds: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const shown = new Set<string>();
    for (const a of attempts) {
      const ids = Array.isArray(a?.shownResourceIds) ? a.shownResourceIds : [];
      for (const id of ids) shown.add(String(id));
    }
    // Nothing shown yet is the clearest possible "too early".
    if (shown.size === 0) {
      return { ok: false, reason: "No product has been shown in this conversation yet, so there is nothing to complement. Search and present options first, and only offer add-ons once the customer has chosen one." };
    }
    if (!shown.has(wanted)) {
      return { ok: false, reason: `Product ${wanted} was never shown to this customer, so it cannot be what they chose. Offer add-ons only for a product from the results you presented.` };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn("[discovery] complementary gate failed (non-fatal, allowing):", err?.message);
    // A read-only cross-sell is not worth failing a turn over.
    return { ok: true };
  }
}

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
