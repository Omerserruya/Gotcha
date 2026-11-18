/**
 * Reply engine v2: one turn, end to end. See contract.ts and
 * docs/architecture/reply-engine-v2.md.
 */
import { prisma, recordUnansweredQuestion } from "@chatcenter/shared";
import { generateResponse, platformPaidScope } from "../ai.service";
import { resolveAgentModel } from "../../lib/agent-model";
import { loadRecentHistory, historyChatMessages, earlierNote, isPersonOutbound } from "../conversation-history.service";
import { getCompanyContext } from "../company-context.service";
import { prepareShopifyTurn } from "../shopify-chat-turn.service";
import { prepareWebchatCommerceTurn, webchatStorefrontBlock, WOO_COMPLEMENTARY_TOOL, wooComplementaryProducts, claimCrossSell, releaseCrossSell, customerSearchQuery, baseSizesAsked, conversationAudience, carriedColour } from "../woo-chat-turn.service";
import { genericStoreQuery } from "../connectors/woocommerce.adapter";
import { computeCalendarCapability } from "../calendar-capability.service";
import { makeScheduleMeetingHandler, makeCheckAvailabilityHandler, makeRescheduleMeetingHandler, makeCancelMeetingHandler, resolveActiveBooking } from "../schedule-handler.service";
import { executeCustomApiTool } from "../connectors/custom-api.service";
import { executeAdapterTool } from "../connectors/integration-framework";
import { enrichProductSearchArgs, isComplementaryTool, complementaryAnchorAllowed } from "../discovery-integration.service";
import { resolveProductRef } from "../product-search.service";
import { retrieveRelevantChunks, buildKnowledgeContext, shouldRecordKnowledgeGap, lexicalKnowledge, mergeKnowledge, knowledgeLimit, documentAddress } from "../knowledge.service";
import { humanizeReply } from "../reply-style";
import { takeShowLine, ungroundedPrices, stripPrices, asksSomething } from "../reply-style-check.service";
import { skillApprovalReason } from "../skill-runtime.service";
import { getCrmAdapter } from "../connectors/crm-adapter-resolver";
import { invalidateCrmPrefetch } from "../crm-prefetch.service";
import { assertOrderTargetMatchesTurn, isOrderStateChangingTool } from "../order-reference.service";
import type { AIBotReplyResult } from "../ai-bot.service";
import type { Claim, EngineTurnTrace, ModelTurnOutput, OfferedItem, ReplyEngineMode, StateLane } from "./contract";
import { engineConfig } from "./flags";
import { loadState, mergeState, saveState, saveSummary, renderState, isTeamPromise, TEAM_OPEN_MS, CANNED_SENT_FACT, SAFETY_FACT, SEARCH_FAIL_FACT, INACTIVE_ORDERS_FACT } from "./state";
import { loadEngineSkills, splitInline } from "./skills";
import { buildSurface } from "./surface";
import { buildStablePrefix, buildTurnPart, ENGINE_PROMPT_VERSION } from "./prompt";
import { relevanceGateMode, relevanceForTurn } from "./relevance-gate";
import { teamPassIn, automatedInbound, MODEL_SAYS_AUTOMATED, endsWithCannedTeamLine, inactiveOrdersIn, ackOnly, picksProduct, paymentProblem, productAskNow, dropPersonPromises, removeTeamLines, normalizeQuotes, gate1, gate3, correctionNote, safeFallback, groundedProductFallback, needlessHandoff, cleanStyle, factualProblems, isCannedTeamLine, tooThin, stripFactProblems, stripForeignScript, autoLookups, notFoundReply, normalizeDashes, promisesPerson, ignoredYes, noInfo, teamLineIn, safetyCase, statusAsk, hasStopUse, safetyWord, customerDescribesUse, stripDirectives, orderTurn, dropDanglingPrice, fixNearTitles, holdingItem, holdReply, bringsDetails, aboutHeld, dropUnaskedName, signedNames } from "./gates";
import { newTurnTools, runToolRound, type ModelToolCall, type RunnerEnv } from "./tools";

export interface EngineTurnOpts {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  incomingMessage: string;
  closedHours?: { nextOpeningIso: string | null; timezone: string; nextOpeningText?: { en?: string; he?: string } | null };
  sandbox?: { enabled: true; writes: "safe" | "real" };
  /** Replay a past turn: history is cut at this message (nothing after it is visible); lane "replay". */
  replay?: { asOf: Date; messageId: string };
}

const HEB = /[֐-׿]/;

const MEDIA_ONLY = /^\s*\[(?:Image|Photo|Video|Voice message|Audio|Document|Sticker|File|Location|Contact)[^\]]*\]\s*$/i;
const LATIN_WORD = /[A-Za-z]{2,}/;

/**
 * The conversation's language: the customer's own recent words decide. Words
 * with no language in them ("[Image]", an order number, "ok") do not: then the
 * whole conversation does, ours included (prod replay 2: a Hebrew chat whose last
 * messages were photos and a number got an English fallback).
 */
export function conversationLocale(inbound: string[], outbound: string[] = []): "he" | "en" {
  const words = inbound.filter((m) => !MEDIA_ONLY.test(String(m ?? ""))).slice(-4).join(" ");
  if (HEB.test(words)) return "he";
  if (LATIN_WORD.test(words.replace(/\bok\b/gi, ""))) return "en";
  return [...inbound, ...outbound].some((m) => HEB.test(String(m ?? ""))) ? "he" : "en";
}

/**
 * What legacy adds to every store search and v2 did not (prod replay 5: a pad
 * narrower than the appliance, a second appliance's size ignored):
 *   - every base size the customer gave, one per appliance (fits_cm_all); the
 *     store then returns, per size, what fits it, or the largest marked too_small;
 *   - the customer's own Hebrew words when the model searched in Latin or vaguely;
 *   - who they are shopping for, and a colour a refinement left unsaid.
 * Sizes are read from this message and the customer's last few (a size given
 * three messages ago still holds).
 */
const ITEM_STOP = new Set(["יש", "לכם", "לך", "אני", "מחפש", "מחפשת", "מחפשים", "רוצה", "רוצים", "צריך", "צריכה", "אפשר", "גם", "עוד", "את", "של", "עם", "על", "בשביל", "למכשיר", "מכשיר", "שלי", "שלנו", "איזה", "איזו", "מה", "האם", "היי", "שלום", "תודה", "בבקשה", "משהו", "כזה", "כזו"]);
const itemWords = (t: string) => (String(t ?? "").match(/[\u0590-\u05FF]{3,}/g) ?? []).filter((w) => !ITEM_STOP.has(w));
const itemStem = (w: string) => (w.length > 3 && /^[הובלמשכ]/.test(w) ? w.slice(1) : w);
/** The first content word of the customer's message: the item they named. */
export const namedItem = (incoming: string) => itemWords(incoming)[0] ?? "";
/** The customer named an item (a Hebrew noun) that the model's query does not contain. */
export function namesOtherItem(incoming: string, query: string): boolean {
  // Only a message that asks for an item ("והמחיר?" names none).
  if (!/(?<![\u0590-\u05FF])(?:יש\s+לכם|יש\s+לך|מחפש|מחפשת|מחפשים|רוצה|רוצים|צריך|צריכה|אפשר\s+לקבל|אפשר\s+להזמין)(?![\u0590-\u05FF])/u.test(incoming ?? "")) return false;
  const theirs = itemWords(incoming).map(itemStem);
  if (!theirs.length) return false;
  const mine = itemWords(query).map(itemStem);
  return !theirs.some((w) => mine.some((m) => m.includes(w) || w.includes(m)));
}

export function withCustomerSearchFacts(args: Record<string, any>, history: any[], incoming: string): Record<string, any> {
  let out = { ...args };
  const inbound = history.filter((m: any) => m?.direction === "INBOUND");
  if (!/[\u0590-\u05FF]/.test(String(out.query ?? "")) || genericStoreQuery(out.query)) {
    const own = customerSearchQuery(history, incoming, out.query);
    if (own && /[\u0590-\u05FF]/.test(own)) out.customer_query = own;
  } else if (typeof out.query === "string" && namesOtherItem(incoming, out.query)) {
    // The customer named an item and the model searched another (prod replay 7): their noun goes first.
    out.query = `${namedItem(incoming)} ${out.query}`.slice(0, 120);
  }
  if (out.fits_cm == null && out.fits_cm_all == null) {
    const seen = new Set<string>();
    const sizes: Array<[number, number]> = [];
    const recent = [...inbound.slice(-6).map((m: any) => String(m.body ?? "")), incoming];
    for (const text of recent) for (const s of baseSizesAsked([], text)) {
      const k = s.join("x");
      if (!seen.has(k)) { seen.add(k); sizes.push(s); }
    }
    if (sizes.length) out = { ...out, fits_cm: sizes[0], fits_cm_all: sizes.slice(-4) };
  }
  if (out.audience == null) {
    const audience = conversationAudience(history, incoming);
    if (audience) out.audience = audience;
  }
  if (typeof out.query === "string") {
    const colour = carriedColour(history, incoming, out.query);
    if (colour) out.query = `${colour} ${out.query}`;
  }
  return out;
}

/** The query-side facts of withCustomerSearchFacts (the named item, a carried colour), for a store whose search takes a query only. */
export function withCustomerQueryWords(args: Record<string, any>, history: any[], incoming: string): Record<string, any> {
  let out = { ...args };
  if (typeof out.query !== "string" || !out.query.trim()) return out;
  if (namesOtherItem(incoming, out.query)) out.query = `${namedItem(incoming)} ${out.query}`.slice(0, 120);
  const colour = carriedColour(history, incoming, out.query);
  if (colour) out = { ...out, query: `${colour} ${out.query}` };
  return out;
}

/** A product named instead of keyed: the same store's own search, by that name. */
export function storeSearchByName(toolFunctionName: string, name: string, locale: string): { tool: string; args: Record<string, unknown> } | null {
  const q = String(name ?? "").slice(0, 80);
  if (/^woocommerce\./.test(toolFunctionName)) return { tool: "woocommerce.list_products", args: { query: q, per_page: 5, lang: locale } };
  if (/^shopify\./.test(toolFunctionName)) return { tool: "shopify.search_products", args: { query: q, limit: 5 } };
  return null;
}

/**
 * "My orders" are the ones the channel proves: a phone or an email the customer
 * typed is not proof, and the guard refused every such lookup (prod replay 5, 9
 * refusals). Without them the guard supplies the customer's own; with none the
 * adapter refuses (phone_email_or_customer_id_required), never lists all orders.
 */
export function scrubOrderSelectors(toolFunctionName: string, args: Record<string, any>): Record<string, any> {
  if (toolFunctionName !== "woocommerce.list_customer_orders") return args;
  const { phone: _p, email: _e, customer_id: _c, ...rest } = args ?? {};
  return rest;
}

/**
 * The orders came from the number the customer writes from, not the one they
 * typed (prod replay 6, Smoovee: the order WAS theirs, and the reply called it a
 * mismatch with the number they gave, opened a team check and repeated it seven
 * times). The model is told what the lookup used.
 */
/**
 * Replay only: the store answers with TODAY's orders, so an order created after
 * the replayed message did not exist yet (prod replay 7: a shipment and a
 * re-order's payment from later). Created after asOf: gone from a list, "not
 * found" for one order. An order's status is still today's (Woo keeps no
 * history of it); the replay report should not rate order-status turns.
 */
// The order reads of both stores (Shopify parity, 2026-11-17).
const ORDER_READ = /^(?:woocommerce\.(?:get_order|list_customer_orders|list_orders)|shopify\.(?:get_order|order_lookup|get_orders|search_orders|get_customer_orders|find_latest_order))$/;
const SINGLE_ORDER = /^(?:woocommerce\.get_order|shopify\.(?:get_order|order_lookup|find_latest_order))$/;
/** Why an order read is refused on this turn, or null (prod rating 2026-11-17: orders volunteered on a "thanks"). */
export function refuseOrderRead(toolFunctionName: string, incoming: string, history: any[]): string | null {
  if (!ORDER_READ.test(toolFunctionName)) return null;
  const lastOut = [...(history ?? [])].reverse().find((m: any) => m?.direction === "OUTBOUND")?.body ?? null;
  return orderTurn(incoming, lastOut) ? null : "not_asked: the customer's message is not about an order or a payment; do not look up or mention orders";
}
export function ordersAsOf(toolFunctionName: string, result: any, asOf: Date): any {
  if (!ORDER_READ.test(toolFunctionName) || !result?.ok) return result;
  // Woo's local time without a zone is UTC in _gmt; Shopify's created_at carries its zone.
  const created = (o: any) => Date.parse(String(o?.date_created_gmt ?? o?.date_created ?? o?.created_at ?? o?.createdAt ?? "").replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z"));
  const later = (o: any) => { const t = created(o); return Number.isFinite(t) && t > asOf.getTime(); };
  if (Array.isArray(result.result)) return { ...result, result: result.result.filter((o: any) => !later(o)) };
  if (result.result && typeof result.result === "object" && later(result.result)) return { ok: false, failure: "refused", reason: "order_not_found: no such order" };
  return result;
}

/**
 * A cancelled, failed or refunded order is not the customer's order to talk about as
 * if it were live (prod replay 9: a cancelled order given as "your order number").
 * Each such order is marked, and the result says how to speak of it.
 */
const INACTIVE = new Set(["cancelled", "canceled", "failed", "refunded", "voided", "trash"]);
// Woo's status; Shopify's cancelled_at and financial status.
const inactiveWhy = (o: any): string | null => {
  if (!o || typeof o !== "object") return null;
  if (INACTIVE.has(String(o.status ?? "").toLowerCase())) return String(o.status);
  if (o.cancelled_at || o.cancelledAt) return "cancelled";
  const fin = String(o.financial_status ?? o.displayFinancialStatus ?? "").toLowerCase();
  return fin === "refunded" || fin === "voided" ? fin : null;
};
export function labelInactiveOrders(toolFunctionName: string, result: any): any {
  if (!ORDER_READ.test(toolFunctionName) || !result?.ok) return result;
  const mark = (o: any) => { const why = inactiveWhy(o); return why ? { ...o, inactive: `${why}: not an active order` } : o; };
  const list = Array.isArray(result.result) ? result.result.map(mark) : mark(result.result);
  const any = Array.isArray(list) ? list.some((o: any) => o?.inactive) : !!list?.inactive;
  return any
    ? { ...result, result: list, note: "An order marked inactive (cancelled, failed or refunded) is not active: never present it as the customer's order or give its number as theirs; say it was cancelled (or failed, or refunded), and use an active order if there is one." }
    : result;
}

/**
 * A single order the guard let through IS this customer's (it matched the number or the
 * email they write from). Prod replay 12: in get_order turns the reply still said "the
 * numbers differ" after the customer had typed another one.
 */
export function ownOrderNote(toolFunctionName: string, result: any): any {
  if (!SINGLE_ORDER.test(toolFunctionName) || !result?.ok || !result.result || Array.isArray(result.result)) return result;
  return { ...result, note: [result.note, "This order is confirmed as this customer's own (it matches the number or email they are writing from). Never tell them a number differs or does not match; a number they typed elsewhere does not matter."].filter(Boolean).join(" ") };
}

/** The model passed a phone, email or customer id to "my orders", which the scrub drops. */
export function droppedOrderSelectors(toolFunctionName: string, args: Record<string, any>): boolean {
  return toolFunctionName === "woocommerce.list_customer_orders" && ["phone", "email", "customer_id"].some((k) => args?.[k] != null && args[k] !== "");
}

export function withOwnNumberNote(result: any): any {
  if (!result || result.ok !== true) return result;
  const found = Array.isArray(result.result) ? result.result.length : null;
  return {
    ...result,
    note: found
      ? "These orders are registered on the number the customer is writing from (looked up by it, not by a number they typed). That is their own order: say it is registered on the number they are writing from (\"ההזמנה רשומה על המספר שממנו כותבים אלינו\"). It is not a mismatch; do not ask the team to check it."
      : "Nothing is registered on the number the customer is writing from. A number they typed is not used to look orders up: ask for the order number.",
  };
}

/**
 * The products a text-channel reply means: its card keys, a key in the text, a
 * title it names; else, when it presents products ("הנה", "יש לנו"), the first
 * three in stock. Exact store fields only; one the reply already links is skipped.
 */
// Function words only. What is NOT distinctive in a store's titles (its brand, the word
// every product shares) is computed from this turn's titles (commonTitleWords), never listed.
const TITLE_STOP = new Set(["של", "עם", "על", "או", "for", "the", "and", "with", "of"]);
const titleWords = (t: string, common: Set<string> = new Set()) => (String(t ?? "").toLowerCase().match(/\p{L}{3,}|\d+(?:[*x×]\d+)?/gu) ?? []).filter((w) => !TITLE_STOP.has(w) && !common.has(w));
/** Words in at least half of the titles (two or more): a brand or the category, shared by all. */
export function commonTitleWords(titles: string[]): Set<string> {
  const list = titles.filter(Boolean);
  if (list.length < 2) return new Set();
  const n = new Map<string, number>();
  for (const t of list) for (const w of new Set(titleWords(t))) n.set(w, (n.get(w) ?? 0) + 1);
  return new Set([...n].filter(([w, k]) => k >= 2 && k >= list.length / 2 && !/^\d/.test(w)).map(([w]) => w));
}
/** The text names this product: its whole title, two of its distinctive words, or its size. */
export function namesTitle(prose: string, title: string, common: Set<string> = new Set()): boolean {
  if (prose.includes(title)) return true;
  const text = String(prose ?? "").toLowerCase();
  const words = titleWords(title, common);
  const size = words.find((w) => /\d+[*x×]\d+/.test(w));
  if (size && new RegExp(size.replace(/[*x×]/, "\\s*[*x×]\\s*")).test(text)) return true;
  return words.filter((w) => !/^\d+$/.test(w) && text.includes(w)).length >= 2;
}
/** The text speaks of specific products (a distinctive title word) even if none matches fully: no generic list then. */
function namesAnyProductWord(prose: string, candidates: any[], common: Set<string> = new Set()): boolean {
  const text = String(prose ?? "").toLowerCase();
  return candidates.some((c) => titleWords(c?.title, common).some((w) => w.length >= 4 && !/^\d+$/.test(w) && text.includes(w)));
}

export function textProductList(o: ModelTurnOutput, prose: string, candidates: any[], locale: "he" | "en"): { text: string; keys: string[] } | null {
  if (!candidates.length) return null;
  const n = new Set<number>();
  for (const k of [...(o.cards ?? []), ...(String(o.reply ?? "").match(/PRODUCT_\d+/gi) ?? [])]) {
    const i = Number(/PRODUCT_(\d+)/i.exec(k)?.[1]);
    if (i >= 1 && i <= candidates.length) n.add(i);
  }
  // A title named exactly, or by its distinctive words (two of them, or a size like "34*38"):
  // the list is exactly the products the text names (prod replay 8: the text named A and B, the list added C).
  const common = commonTitleWords(candidates.map((c) => String(c?.title ?? "")));
  candidates.forEach((c, i) => { if (c?.title && namesTitle(prose, c.title, common)) n.add(i + 1); });
  if (!n.size && /(?<![\u0590-\u05FF])(?:הנה|יש\s+לנו|יש\s+כמה|אפשרויות|מתאים|מתאימים)(?![\u0590-\u05FF])|\b(?:here (?:are|is)|we have|options|fits)\b/iu.test(prose) && !namesAnyProductWord(prose, candidates, common)) {
    candidates.forEach((c, i) => { if (n.size < 3 && c?.title && c.inventoryState !== "out_of_stock") n.add(i + 1); });
  }
  // Never twice: a product the text already lists as a line of its own (a fallback's bullets) is not listed again.
  const listedInText = (t: string) => new RegExp(`(?:^|\\n)\\s*[•\\-*]\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(prose);
  const chosen = [...n].slice(0, 3).map((i) => ({ i, c: candidates[i - 1] })).filter((x) => x.c?.title && !(x.c.url && prose.includes(x.c.url)) && !listedInText(String(x.c.title)));
  if (!chosen.length) return null;
  const cur = (c: any) => (c.currency === "ILS" || !c.currency ? "₪" : `${c.currency} `);
  const lines = chosen.map(({ c }) => [
    c.title,
    c.priceOnSite ? (locale === "he" ? "המחיר באתר" : "price on the site") : c.price != null ? `${cur(c)}${c.price}` : null,
    c.inventoryState === "in_stock" ? (locale === "he" ? "במלאי" : "in stock") : c.inventoryState === "out_of_stock" ? (locale === "he" ? "אזל מהמלאי" : "out of stock") : null,
    c.url ?? null,
  ].filter(Boolean).join("\n"));
  return { text: lines.join("\n\n"), keys: chosen.map((x) => `PRODUCT_${x.i}`) };
}

/** The customer asks to be called (prod replay 8: "יכול להתקשר אלי?" ignored). */
export const CALL_REQUEST = /(?<![\u0590-\u05FF])[וש]?(?:תתקשרו|תתקשר|תתקשרי|להתקשר\s+אלי|יכול(?:ה|ים)?\s+להתקשר|אפשר\s+(?:להתקשר|שיחה|לדבר\s+בטלפון)|שיחה\s+טלפונית|שיחת\s+טלפון|תחזרו\s+אלי\s+(?:בטלפון|טלפונית)|תצלצלו|לצלצל\s+אלי|שמישהו\s+יתקשר)(?![\u0590-\u05FF])|\b(?:call me|give me a call|phone me|can (?:you|someone) call)\b/iu;

const wordCount = (s: string) => (String(s ?? "").match(/[\u0590-\u05FFA-Za-z0-9]+/g) ?? []).length;
/** The sentences of `before` that are not in `after` (what a cleanup cut). */
export function removedSentences(before: string, after: string): string[] {
  const keep = String(after ?? "");
  return (String(before ?? "").match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x && !keep.includes(x));
}

/** A profile address that names a street and a number, not only a town ("הסטודיו נמצא בנהריה"). */
export const profileHasStreet = (address: string | null | undefined) => /[\u0590-\u05FFA-Za-z]{2,}\s+\d{1,4}/.test(String(address ?? ""));

/**
 * The last word on what reaches the customer, on every path: no run of 3+ symbol
 * characters (#, +, *, =, ~, _, |, mixed or not), no markdown fence, no control or
 * zero-width character (the emoji joiner stays), no tail of symbols after the last
 * sentence.
 */
/** A quote or bracket at the start or end with no partner in the text (prod replay 2026-11-17: `" I can check...`). */
export function stripUnmatchedEdges(text: string): string {
  let s = String(text ?? "").trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["\u201C", "\u201D"], ["\u00AB", "\u00BB"], ["(", ")"], ["[", "]"], ["{", "}"]];
  for (let k = 0; k < 3; k++) {
    let changed = false;
    for (const [open, close] of pairs) {
      const count = (ch: string) => s.split(ch).length - 1;
      const balanced = open === close ? count(open) % 2 === 0 : count(open) === count(close);
      if (!balanced && s.startsWith(open) && (open === close || count(open) > count(close))) { s = s.slice(open.length).trim(); changed = true; }
      else if (!balanced && s.endsWith(close) && (open === close || count(close) > count(open))) { s = s.slice(0, -close.length).trim(); changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

export function sanitizeReply(text: string): string {
  // The card protocol never reaches the customer, on any path (prod rating 2026-11-17, Tehila: a "SHOW:" line).
  return stripUnmatchedEdges(stripDirectives(String(text ?? ""))
    // A sarcastic or awkward face is not a warm sign-off (prod replay 2026-11-17: 🙃).
    .replace(/\s*(?:\u{1F643}|\u{1F605}|\u{1F644}|\u{1F612}|\u{1F611})\uFE0F?/gu, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
    .replace(/[#+*=~_|](?:[ \t]*[#+*=~_|]){2,}/g, "")
    .replace(/[^\p{L}\p{N}.!?)"'״׳\p{Extended_Pictographic}\u200D\uFE0F\s]+$/u, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

export const RESEND_HE = "ההודעה לא הגיעה אלינו, אפשר לשלוח שוב כטקסט?";
export const RESEND_EN = "Your message didn't come through. Could you send it again as text?";
/** An inbound the channel could not deliver as text (not a template, a reaction or an edit). */
export const unsupportedInbound = (text: string | null | undefined) => /^\[(?:unsupported[^\]]*|unreadable[^\]]*|unknown[^\]]*|הודעה\s+לא\s+נתמכת[^\]]*)\]$/iu.test(String(text ?? "").trim());

/** A message that is only a placeholder: a template, an unsupported message, an empty one. */
export function placeholderOnly(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  // Platform events are no customer text either (prod replay 2026-11-17: "[edit message]").
  return !t || /^\[(?:template[^\]]*|unsupported[^\]]*|interactive[^\]]*|button[^\]]*|reaction[^\]]*|empty[^\]]*|edit(?:ed)?\s+message[^\]]*|message\s+(?:edited|deleted|revoked|unsent|removed)[^\]]*|deleted\s+message[^\]]*|revoked[^\]]*|system[^\]]*|ephemeral[^\]]*|poll[^\]]*|הודעה\s+(?:לא\s+נתמכת|נערכה|נמחקה|בוטלה)[^\]]*|תבנית[^\]]*)\]$/iu.test(t);
}

/** Drops a sentence that repeats one already in the same reply. */
export function dedupeSentences(reply: string): string {
  const seen = new Set<string>();
  const parts = String(reply ?? "").match(/[^.!?\n]+[.!?]*\s*/g) ?? [String(reply ?? "")];
  return parts.filter((x) => { const k = x.trim().replace(/\s+/g, " "); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }).join("").trim();
}

/** Parse the model's `respond` arguments, tolerantly. */
const TEAM_PROMISE_PREFIX = "checking with the team: ";

/** The team questions still open in this conversation's state (younger than TEAM_OPEN_MS). */
export function openTeamQuestions(state: { pending?: Array<{ kind?: string; text?: string; at?: string }> } | null | undefined, now = Date.now()): string[] {
  return (state?.pending ?? [])
    .filter((p) => isTeamPromise(p) && !(now - Date.parse(p.at ?? new Date(now).toISOString()) > TEAM_OPEN_MS))
    .map((p) => String(p.text).slice(TEAM_PROMISE_PREFIX.length));
}

// The model's team questions share a frame ("הלקוח שואל אם יש..."): never evidence of one issue.
const FILLER = new Set(["הלקוח", "הלקוחה", "לקוח", "לקוחה", "שואל", "שואלת", "שואלים", "מבקש", "מבקשת", "רוצה", "האם", "אם", "יש", "אין", "של", "את", "על", "עם", "זה", "זו", "לו", "לה", "לי", "גם", "או", "כי", "מה", "איך", "מתי", "איפה", "אפשר", "לגבי", "בנוגע", "the", "customer", "asks", "asked", "wants", "whether", "if", "is", "are", "there", "can", "about", "for", "of", "to", "and", "or", "a", "an"]);
const words = (s: string) => new Set(String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !FILLER.has(w)));
/** Two team questions about the same issue: enough shared words (a reworded repeat still counts). */
/** The open team item a repeat belongs to, with the digits the customer just gave that it lacks. */
export function withNewDetails(pending: Array<{ kind?: string; text?: string; at?: string }>, question: string, incoming: string): { pending: any[]; added: string[]; text: string } | null {
  const digits = [...new Set(String(incoming ?? "").match(/\d{4,}/g) ?? [])];
  if (!digits.length) return null;
  const i = pending.findIndex((p) => isTeamPromise(p) && sameIssue(String(p.text ?? "").slice(TEAM_PROMISE_PREFIX.length), question));
  if (i < 0) return null;
  const added = digits.filter((d) => !String(pending[i].text ?? "").includes(d));
  if (!added.length) return null;
  const text = `${pending[i].text} (customer gave: ${added.join(", ")})`.slice(0, 260);
  return { pending: pending.map((p, k) => (k === i ? { ...p, text } : p)), added, text: text.slice(TEAM_PROMISE_PREFIX.length) };
}

/** A conversation with one of the tenant's own users (their phone on the users table): internal, not a customer. */
export async function internalSender(tenantId: string, channel: string, externalId: string | null | undefined, db: any = prisma): Promise<boolean> {
  if (!/^(?:WHATSAPP|VOICE)$/i.test(channel)) return false;
  const digits = String(externalId ?? "").replace(/\D/g, "");
  if (digits.length < 9) return false;
  const users: any[] = await db.user.findMany({ where: { tenantId, phoneNumber: { not: null } }, select: { phoneNumber: true }, take: 200 });
  return users.some((u) => String(u.phoneNumber ?? "").replace(/\D/g, "").slice(-9) === digits.slice(-9));
}

/** The conversation was handed back to the AI after `since`: a returned_to_ai event in the history, or a handover row to the AI. */
export async function handedBackSince(tenantId: string, conversationId: string, since: Date, history: any[], asOf: Date | null = null, db: any = prisma): Promise<boolean> {
  const t = since.getTime();
  const until = asOf ? asOf.getTime() : Infinity;
  const inHistory = history.some((m: any) => {
    const at = new Date(m.createdAt ?? 0).getTime();
    const ev = String((m.metadata as any)?.systemEvent ?? (m.metadata as any)?.event ?? "");
    return at > t && at <= until && (ev === "returned_to_ai" || ev === "handed_back_to_ai");
  });
  if (inHistory) return true;
  const row = await db.conversationHandover?.findFirst?.({
    where: { tenantId, conversationId, toHandler: "ai_agent", at: { gt: since, ...(asOf ? { lte: asOf } : {}) } },
    select: { id: true },
  });
  return !!row;
}

// The subject of an open item as a fixed noun, never its text (prod replay 2026-11-17).
const SUBJECT_NOUNS: Array<[RegExp, string, string]> = [
  [/קופון|קוד\s*(?:הנחה|קופון)?|coupon|promo|discount code/iu, "הקופון", "the coupon"],
  [/חיוב|חויב|תשלום|שילמ|כסף|זיכוי|החזר\s+כספי|charge|payment|refund/iu, "החיוב", "the charge"],
  [/משלוח|חבילה|שליח|delivery|shipping|package|parcel/iu, "המשלוח", "the delivery"],
  [/הזמנה|order/iu, "ההזמנה", "your order"],
  [/החלפה|החזרה|exchange|return/iu, "ההחזרה", "the return"],
];
/** "<noun> is still being checked" when the subject maps to a fixed noun, else a neutral line. Never the item's own text. */
export function stillCheckingLine(subjectText: string, locale: "he" | "en"): string {
  const hit = SUBJECT_NOUNS.find(([re]) => re.test(String(subjectText ?? "")));
  if (locale === "he") return hit ? `${hit[1]} עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.` : "זה עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.";
  return hit ? `${hit[2].charAt(0).toUpperCase()}${hit[2].slice(1)} is still being checked by the team; the answer will come here in the chat.` : "This is still being checked by the team; the answer will come here in the chat.";
}
// The reply offers to ask the team instead of saying it did.
const OFFERS_TO_ASK = /(?<![\u0590-\u05FF])(?:רוצה|תרצי|תרצה|תרצו|שאבדוק|שאשאל|שאעביר|שנבדוק|שנעביר)[^.!?\n]{0,40}\?|\b(?:would you like (?:me|us) to (?:ask|check|pass)|shall (?:i|we) (?:ask|check)|should (?:i|we) (?:ask|check))\b/iu;
export const offersToAsk = (reply: string) => OFFERS_TO_ASK.test(reply ?? "");

/** A first name the greeting may use: letters (a space between parts), not camelCase or a handle, no digits. */
export function greetingName(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t || t.length > 40 || /[\d@_./\\]/.test(t) || /\p{Ll}\p{Lu}/u.test(t)) return null;
  if (!/^\p{L}[\p{L}'\u05F3-]*(?:\s+\p{L}[\p{L}'\u05F3-]*){0,3}$/u.test(t)) return null;
  return t.split(/\s+/)[0];
}

/** A product the customer named (a distinctive word of theirs) is among this turn's results. */
export function namedInResults(incoming: string, candidates: any[]): boolean {
  const words = (String(incoming ?? "").toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((w) => w.length >= 3);
  return candidates.some((c) => { const t = String(c?.title ?? "").toLowerCase(); return words.some((w) => w.length >= 4 && t.includes(w.replace(/^[הולבמש]/, ""))); });
}

/**
 * The outgoing message: the prose, then the list, with no product title twice and no line twice.
 * A list block whose title the prose already carries with a price or a link is dropped (prod replay
 * 2026-11-17: the fallback's own bullets, then the same products listed again).
 */
export function assembleOnce(prose: string, list: string | null, titles: string[]): string {
  let blocks = list ? list.split(/\n\n+/) : [];
  const proseLines = String(prose ?? "").split("\n");
  const priced = (t: string) => proseLines.some((l) => l.toLowerCase().includes(t.toLowerCase()) && /₪|ש["״']?ח|\d+\s?(?:NIS|ILS)|https?:\/\/|המחיר באתר|price on the site/i.test(l));
  // The prose names it by a shorter name with the block's own price (prod rating 2026-11-17, Tami 4).
  const proseText = String(prose ?? "").toLowerCase();
  const pricedShort = (t: string, block: string) => {
    const price = /(\d+(?:\.\d+)?)/.exec(block.split("\n").slice(1).join(" "))?.[1];
    if (!price || !proseText.includes(price)) return false;
    const words = t.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    return words.length >= 2 ? proseText.includes(words.slice(0, 2).join(" ")) : proseText.includes(t.toLowerCase());
  };
  blocks = blocks.filter((b) => { const t = titles.find((x) => b.split("\n")[0].trim() === x.trim()); return !t || (!priced(t) && !pricedShort(t, b)); });
  const all = [stripDirectives(String(prose ?? "")).trim(), ...blocks].filter(Boolean).join("\n\n");
  // No line twice (a header, a bullet), blank lines kept as separators.
  const seen = new Set<string>();
  // A line's ending punctuation does not make it new ("…שמתאים." and "…שמתאים:" are one header).
  return all.split("\n").filter((l) => { const k = l.trim().replace(/[\s.:!,]+$/u, ""); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The fallback for a product ask with nothing grounded to show: one question about what is wanted. */
export function productQuestionLine(locale: "he" | "en"): string {
  return locale === "he" ? "כדי למצוא את המתאים: לאיזה דגם או שימוש זה, ובאיזו מידה?" : "To find the right one: which model or use is it for, and what size?";
}

/** The inactive-orders fact after this turn: the known numbers plus this turn's, at most 20. */
export function inactiveOrdersFact(prev: unknown, now: string[]): Record<string, string> {
  if (!now.length) return {};
  const all = [...new Set([...String(prev ?? "").split(",").filter(Boolean), ...now])].slice(-20);
  return { [INACTIVE_ORDERS_FACT]: all.join(",") };
}

/** A team question as the team reads it: the subject (the case, the product) and the customer's ask; null for a status ask on an open item. */
export function teamQuestionText(q: string, incoming: string, state: { intent?: string | null; offeredItems?: Array<{ title?: string }> } | null, openItems: string[]): string | null {
  const text = String(q ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (openItems.length && statusAsk(incoming) && String(incoming ?? "").replace(/\s+/g, " ").trim().length < 40) return null;
  const raw = text === String(incoming ?? "").replace(/\s+/g, " ").trim();
  if (!raw || /^call request:/i.test(text)) return text.slice(0, 300);
  const subject = String(state?.intent ?? "").trim() || String(state?.offeredItems?.at(-1)?.title ?? "").trim();
  return (subject && !text.includes(subject) ? `${subject.slice(0, 80)}: ${text}` : text).slice(0, 300);
}

/** The customer's subjects (clauses joined by a comma, "and", "או", "וגם" or a "וה" noun) that no open team item covers. */
export function uncoveredSubjects(incoming: string, openItems: string[]): string[] {
  const clauses = String(incoming ?? "").split(/\s*[,;]\s*|\s+(?:and|or|או|וגם|גם)\s+|\s+(?=וה[\u0590-\u05FF]{2,})/iu).map((c) => c.replace(/^ו(?=ה)/u, "").trim()).filter((c) => words(c).size >= 1);
  if (clauses.length <= 1) return openItems.some((t) => sameIssue(t, incoming)) ? [] : [String(incoming ?? "").trim()].filter(Boolean);
  // A clause that carries a number (a card's last four, an order number) is a detail of an open item,
  // added to it (withNewDetails), never a subject of its own.
  return clauses.filter((c) => !openItems.some((t) => sameIssue(t, c)) && !(openItems.length && /\d{4,}/.test(c)));
}

export function sameIssue(a: string, b: string): boolean {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared) >= 0.2 || shared / Math.min(A.size, B.size) >= 0.5;
}

export function parseRespond(raw: string | undefined): ModelTurnOutput | null {
  let v: any;
  try { v = JSON.parse(raw || "{}"); } catch { return null; }
  if (!v || typeof v !== "object" || typeof v.reply !== "string") return null;
  const su = v.state_update && typeof v.state_update === "object" ? v.state_update : {};
  const claims: Claim[] = Array.isArray(v.claims)
    ? v.claims.filter((c: any) => c && typeof c.text === "string").map((c: any) => ({ kind: ["price", "product", "action", "fact"].includes(c.kind) ? c.kind : "fact", text: c.text, source: c.source }))
    : [];
  // The product summary asks for a "SHOW: PRODUCT_1" line (legacy's card protocol):
  // its keys are cards, and the line never reaches the customer (prod replay 4, Tehila).
  const show = takeShowLine(v.reply);
  const cards: string[] = Array.isArray(v.cards) ? v.cards.filter((k: any) => typeof k === "string") : [];
  return {
    reply: show.text,
    stateUpdate: { stage: su.stage, intent: su.intent, facts: su.facts, pending: Array.isArray(su.pending) ? su.pending : undefined },
    claims,
    handoff: typeof v.handoff === "string" && v.handoff.trim() ? v.handoff.trim() : null,
    teamQuestion: typeof v.team_question === "string" && v.team_question.trim() ? v.team_question.trim().slice(0, 500) : null,
    cards: [...new Set([...cards, ...show.keys])],
  };
}

const normTitle = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The store's id for whatever the model put in product_id (eval 2026-11-16: it
 * passed titles, "Zip Hoodie", and keys from an EARLIER turn, "PRODUCT_2"; the
 * store answered 404 and the model told the customer the catalogue was down).
 * In order: a store id as is; this turn's key; a title of this turn's results;
 * a title or id already shown in this conversation (newest first). Null when
 * none: the caller searches by name.
 */
export function resolveProductId(
  value: unknown,
  envelope: { candidates: Array<{ title: string; productId?: string | null }> } | null,
  offered: Array<{ title: string; productId?: string | null }>,
): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^\d{1,15}$/.test(v)) return v;
  const key = /^PRODUCT_(\d{1,3})$/i.exec(v);
  if (key) {
    const c = envelope?.candidates[Number(key[1]) - 1];
    if (c?.productId) return String(c.productId);
  }
  const want = normTitle(v);
  const fromTurn = envelope?.candidates.find((c) => normTitle(c.title) === want);
  if (fromTurn?.productId) return String(fromTurn.productId);
  for (let i = offered.length - 1; i >= 0; i--) {
    const o = offered[i];
    if (o.productId && (normTitle(o.title) === want || String(o.productId) === v)) return String(o.productId);
  }
  return null;
}

/** PRODUCT_n keys never reach the customer: each becomes the product's title. */
export function resolveKeysInText(text: string, candidates: Array<{ title: string }>): string {
  return text.replace(/PRODUCT_(\d{1,3})/gi, (m, n) => candidates[Number(n) - 1]?.title ?? m);
}

/**
 * After our first reply, a reply does not open with a greeting or a filler
 * ("כן,", "בטח,", "מעולה,"): fixed in code, as legacy did (greeting_after_first).
 * The rest of the sentence stands; a reply that is only the filler is kept.
 */
export function stripLaterOpener(text: string, notFirst: boolean): string {
  if (!notFirst) return text;
  const m = /^\s*(?:היי|הי|שלום|אהלן|כן|בטח|מעולה|hi|hey|hello|sure|great)[,!.]\s+/iu.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  return rest.length >= 2 ? rest : text;
}

/**
 * The history as the model reads it: legacy's renderer, so a person's message is
 * marked as a person's ("[Human team member X, not you, wrote to the customer]")
 * and never read as the employee's own (prod replay 4: v2 contradicted, or said
 * "the team is still checking" after, what a person had just answered), media are
 * described, product cards are a line, a long silence is a note.
 */
export function historyToChat(history: any[]): any[] {
  return historyChatMessages(
    history.filter((m: any) => { const kind = (m?.metadata as any)?.kind; return kind !== "interim_ack" && kind !== "holding"; }),
    { window: history.length + 1 },
  );
}

function closedHoursText(c: EngineTurnOpts["closedHours"], locale: "he" | "en"): string | null {
  if (!c) return null;
  const when = (locale === "he" ? c.nextOpeningText?.he : c.nextOpeningText?.en) ?? c.nextOpeningIso ?? "later";
  return `The team is closed now; it opens ${when} (${c.timezone}). You can still help; anything that needs a person waits until then, say so honestly.`;
}

export async function runReplyEngineTurn(opts: EngineTurnOpts, mode: ReplyEngineMode, signal?: AbortSignal): Promise<AIBotReplyResult & { trace: EngineTurnTrace }> {
  const lane: StateLane = opts.replay ? "replay" : mode === "shadow" ? "shadow" : "live";
  if (lane !== "live") {
    // Shadow and replay are paid by the platform: every call is logged billedTo "platform" and nothing is debited.
    return platformPaidScope.run({ reason: `reply_engine_${lane}` }, () => runTurn(opts, mode, lane, signal));
  }
  return runTurn(opts, mode, lane, signal);
}

async function runTurn(opts: EngineTurnOpts, mode: ReplyEngineMode, lane: StateLane, signal?: AbortSignal): Promise<AIBotReplyResult & { trace: EngineTurnTrace }> {
  const cfg = engineConfig();
  const t0 = Date.now();
  const stageMs: Record<string, number> = {};
  const mark = (k: string) => { stageMs[k] = Date.now() - t0; };

  const [config, conversation] = await Promise.all([
    prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } }),
    prisma.conversation.findFirst({ where: { id: opts.conversationId, tenantId: opts.tenantId } }),
  ]);
  if (!config || config.tenantId !== opts.tenantId) throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  // v2's own model (prod: gpt-6-luna, as evaluated) without moving the legacy engine's default.
  const model = (process.env.REPLY_ENGINE_MODEL || "").trim() || resolveAgentModel(config.model);

  const trace: EngineTurnTrace = {
    engine: "v2", mode, lane, gate1: "reply", stageMs, rounds: 0, tools: [],
    gate3: { ok: true, problems: [], rewrite: "none" }, tokens: { input: 0, output: 0, cached: 0 }, toolsOffered: 0,
  };
  const empty = (extra: Partial<AIBotReplyResult>): AIBotReplyResult & { trace: EngineTurnTrace } => ({
    reply: null, escalation: null, awaitingApproval: null, toolCallLog: [], modelUsed: model, totalTokens: 0, ...extra, trace,
  } as any);

  // ── One parallel load ──
  // Started before Gate 1 resolves (reads only; discarded when Gate 1 stops the turn). Each part is timed.
  const loadMs: Record<string, number> = {};
  const timed = <T>(k: string, p: Promise<T>): Promise<T> => { const s0 = Date.now(); return p.finally(() => { loadMs[k] = Date.now() - s0; }); };
  const loadAll = Promise.all([
    timed("state", loadState(opts.tenantId, opts.conversationId, lane)),
    timed("history", opts.replay
      // As of the replayed message: it and what came before, never after.
      ? prisma.message.findMany({
          where: { tenantId: opts.tenantId, conversationId: opts.conversationId, createdAt: { lte: opts.replay.asOf } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 60,
        }).then((rows: any[]) => rows.reverse())
      : loadRecentHistory<any>(opts.tenantId, opts.conversationId, 60)),
    timed("contact", prisma.contact.findFirst({
      where: { tenantId: opts.tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
      select: { id: true, email: true, phone: true },
    }).catch(() => null) as Promise<any>),
    timed("company", getCompanyContext(opts.tenantId)),
    timed("shopify", prepareShopifyTurn({ tenantId: opts.tenantId, conversationId: opts.conversationId }).catch(() => null)),
    timed("calendar", computeCalendarCapability(opts.tenantId, config.id).catch(() => ({ bookable: false } as any))),
    timed("approvals", prisma.approvalRequest.findMany({
      where: { tenantId: opts.tenantId, conversationId: opts.conversationId, status: "PENDING" },
      select: { id: true, tool: true, summary: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }).catch(() => [] as any[])),
    timed("stores", prisma.tenantIntegration.findMany({
      where: { tenantId: opts.tenantId, status: "CONNECTED", integration: { slug: { in: ["shopify", "woocommerce"] } } },
      select: { integration: { select: { slug: true } } },
    }).catch(() => [] as any[])),
    // The vector search and the keyword fallback together (prod replay 5: the address and a pickup city missed).
    timed("knowledge", Promise.all([
      retrieveRelevantChunks(opts.tenantId, String(opts.incomingMessage ?? "").slice(0, 500), 5, config.id, {
        record: lane === "live" && shouldRecordKnowledgeGap({ sandbox: !!opts.sandbox?.enabled, customerExternalId: conversation.customerExternalId, message: opts.incomingMessage }),
        askerKey: opts.conversationId,
      }).catch(() => [] as any[]),
      lexicalKnowledge(opts.tenantId, String(opts.incomingMessage ?? "").slice(0, 500), 5, config.id).catch(() => [] as any[]),
    ]).then(([v, l]) => mergeKnowledge(v as any, l as any, knowledgeLimit(String(opts.incomingMessage ?? ""))))),
    // An address the documents give, for a profile with none (cached per tenant).
    timed("docAddress", documentAddress(opts.tenantId, config.id).catch(() => null)),
    // Both store turns in parallel; a Shopify chat wins when both answer.
    timed("woo", prepareWebchatCommerceTurn({ tenantId: opts.tenantId, conversationId: opts.conversationId }).catch(() => null)),
  ]);
  loadAll.catch(() => {}); // a Gate 1 stop never leaves it unhandled
  // ── Gate 1 ──
  const g1 = await gate1({
    tenantId: opts.tenantId,
    agentStatus: String((config as any).status),
    platformPaid: lane !== "live",
    billingSummary: (a) => {
      // Lazy: avoids an import cycle at module load.
      const { billingPauseSummary } = require("../ai-bot.service");
      return billingPauseSummary(a);
    },
  });
  if (!g1.reply) {
    trace.gate1 = g1.escalation.reason;
    return empty({ escalation: g1.escalation });
  }
  mark("gate1");
  // A template, an unsupported message or an empty placeholder is no customer text (prod replay 12:
  // "only a template attachment was received"): a short neutral opener at the start, else nothing.
  // A person on the team wrote in this conversation in the last 24h (the business app, the phone, an
  // import): it is theirs, the AI stays out (prod replay 2026-11-17, GOTCHA; the worker's owner-recent
  // rule covers WhatsApp only, this covers every channel and the replay alike).
  {
    const hist1: any[] = ((await loadAll.catch(() => null)) as any)?.[1] ?? [];
    const asOf = opts.replay?.asOf ? new Date(opts.replay.asOf).getTime() : Date.now();
    const lastPerson = [...hist1].reverse().find((m: any) => m.direction === "OUTBOUND" && isPersonOutbound(m) && asOf - new Date(m.createdAt ?? 0).getTime() < 24 * 60 * 60_000);
    // ...unless the conversation was handed back to the AI since that message (the inbox's "return to
    // AI": a returned_to_ai system message and a handover row to ai_agent). Then the AI answers, as before.
    const handedBack = lastPerson ? await handedBackSince(opts.tenantId, opts.conversationId, new Date(lastPerson.createdAt ?? 0), hist1, opts.replay?.asOf ? new Date(opts.replay.asOf) : null).catch(() => false) : false;
    if (lastPerson && !handedBack) {
      trace.gate1 = "human_owned:person_recent";
      trace.gate3 = { ok: true, problems: [], rewrite: "none" };
      return empty({ reply: null });
    }
  }
  // The tenant's own team member writing from their phone (prod replay 2026-11-17, GOTCHA): not a customer.
  {
    const internal = await internalSender(opts.tenantId, String(conversation.channel ?? ""), conversation.customerExternalId).catch(() => false);
    if (internal) {
      trace.gate1 = "internal:team_member";
      (trace as any).internal = true;
      trace.gate3 = { ok: true, problems: [], rewrite: "none" };
      return empty({ reply: null });
    }
  }
  // Mail no customer wrote (a newsletter, an account notice, our own alert): no reply, no
  // handoff, no team question, and nothing inside it is acted on (prod replay 2026-11-17).
  {
    const hist0: any[] = ((await loadAll.catch(() => null)) as any)?.[1] ?? [];
    const lastIn = [...hist0].reverse().find((m: any) => m.direction === "INBOUND");
    const platformSender = /<([^>]+)>/.exec(String(process.env.SMTP_FROM ?? ""))?.[1] ?? process.env.SMTP_FROM ?? null;
    const automated = automatedInbound({ channel: String(conversation.channel ?? ""), sender: conversation.customerExternalId, body: opts.incomingMessage ?? lastIn?.body, metadata: lastIn?.metadata, platformSender });
    if (automated) {
      trace.gate1 = `automated:${automated}`;
      (trace as any).automated = automated;
      trace.gate3 = { ok: true, problems: [], rewrite: "none" };
      return empty({ reply: null });
    }
  }
  // Relevance (2026-11-17): personal, notices, marketing, another business's auto-reply, the team's
  // own chats, and a reply to something a person sent first. Off by default; "shadow" only records.
  // A person's override wins over every rule. Not on a replay or a sandbox rehearsal.
  {
    const mode = relevanceGateMode();
    if (mode !== "off" && !opts.replay && !String(conversation.customerExternalId ?? "").startsWith("sandbox:")) {
      const loaded: any = await loadAll.catch(() => null);
      const company = loaded?.[3] ?? null;
      const rel = await relevanceForTurn({ tenantId: opts.tenantId, conversation, history: loaded?.[1] ?? [], profile: company ? { ...company } : null, mode });
      (trace as any).relevance = rel;
      if (mode === "on" && rel.hold) {
        trace.gate1 = `relevance:${rel.category}`;
        trace.gate3 = { ok: true, problems: [], rewrite: "none" };
        return empty({ reply: null });
      }
    }
  }
  if (placeholderOnly(opts.incomingMessage)) {
    const hist: any[] = ((await loadAll.catch(() => null)) as any)?.[1] ?? [];
    const spoke = hist.some((m: any) => m.direction === "OUTBOUND");
    trace.gate3 = { ok: true, problems: [], rewrite: "none" };
    (trace as any).placeholder = true;
    // The language from real words only: a placeholder's English is not the customer's.
    const words = hist.filter((m: any) => m.direction === "INBOUND" && !placeholderOnly(m.body)).map((m: any) => String(m.body ?? ""));
    const en = words.length > 0 && conversationLocale(words, []) === "en";
    // A message the channel could not deliver as text (unsupported, unreadable): ask ONCE per conversation
    // to resend it as text, as legacy did (prod replay 2026-11-17); then silence.
    if (unsupportedInbound(opts.incomingMessage)) {
      const asked = hist.some((m: any) => m.direction === "OUTBOUND" && (String(m.body ?? "") === RESEND_HE || String(m.body ?? "") === RESEND_EN));
      (trace as any).unsupportedInbound = true;
      return empty({ reply: asked ? null : en ? RESEND_EN : RESEND_HE });
    }
    return empty({ reply: spoke ? null : en ? "Hi, how can we help?" : "היי, במה אפשר לעזור?" });
  }

  const [state, history, contactRow, company, shopifyTurn, calendar, pendingApprovals, connectedStores, knowledgeChunks, docAddress, wooRaw] = await loadAll;
  const wooTurn = shopifyTurn ? null : wooRaw;
  Object.assign(stageMs, Object.fromEntries(Object.entries(loadMs).map(([k, v]) => [`load_${k}`, v])));
  const productTurn: any = shopifyTurn ?? wooTurn;
  mark("load");

  const inbound = history.filter((m: any) => m.direction === "INBOUND").map((m: any) => String(m.body ?? ""));
  if (opts.incomingMessage && inbound.at(-1) !== opts.incomingMessage) inbound.push(opts.incomingMessage);
  const locale = conversationLocale(inbound, history.filter((m: any) => m.direction === "OUTBOUND").map((m: any) => String(m.body ?? "")));
  const storePlatform: "shopify" | "woocommerce" | null =
    connectedStores.some((r: any) => r.integration?.slug === "shopify") ? "shopify"
    : connectedStores.some((r: any) => r.integration?.slug === "woocommerce") ? "woocommerce" : null;
  const cardChannel = !!productTurn?.sendShopifyProducts;
  const calendarBookable = !!(calendar as any)?.bookable;
  const booking = calendarBookable
    ? await resolveActiveBooking({ tenantId: opts.tenantId, conversationId: opts.conversationId, aiAgentId: config.id, customerExternalId: conversation.customerExternalId ?? undefined }).catch(() => null)
    : null;

  const [skills, surface, page] = await Promise.all([
    loadEngineSkills({ tenantId: opts.tenantId, aiAgentId: config.id, conversationId: opts.conversationId, role: config.role, storePlatform, locale }),
    buildSurface({
      tenantId: opts.tenantId,
      aiAgentId: config.id,
      hasContact: !!contactRow?.id,
      calendarBookable,
      hasBooking: !!booking,
      productCards: productTurn?.productMessagingEnabled === true,
      wooComplementary: !!wooTurn?.suggestComplementary,
    }),
    shopifyTurn?.storefrontBlock
      ? Promise.resolve(shopifyTurn.storefrontBlock as string)
      : wooTurn ? webchatStorefrontBlock(opts.tenantId, opts.conversationId).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // Every playbook inlined in the prefix: no read_skill to offer.
  if (!splitInline(skills).listed.length) {
    surface.tools = surface.tools.filter((t: any) => t?.function?.name !== "read_skill");
    surface.names = surface.names.filter((n) => n !== "read_skill");
  }
  trace.toolsOffered = surface.names.length;
  mark("surface");

  // ── The tool context (what each dispatch can reach) ──
  const turnTools = newTurnTools();
  const booker = { tenantId: opts.tenantId, aiAgentId: config.id, conversationId: opts.conversationId, customerExternalId: conversation.customerExternalId ?? undefined, customerEmail: contactRow?.email ?? undefined };
  const ctx: any = {
    tenantId: opts.tenantId,
    aiAgentId: config.id,
    conversationId: opts.conversationId,
    contactId: contactRow?.id,
    authToken: process.env.INTERNAL_SERVICE_TOKEN,
    sandbox: opts.sandbox,
    sendShopifyProducts: productTurn?.sendShopifyProducts
      ? (args: any) => productTurn.sendShopifyProducts({
          ...args,
          products: (args.products ?? []).map((p: any) => ({ ...p, productId: resolveProductRef(turnTools.envelope, p?.productId) as string })),
        })
      : undefined,
    scheduleMeeting: calendarBookable ? makeScheduleMeetingHandler(booker) : undefined,
    checkAvailability: calendarBookable ? makeCheckAvailabilityHandler(booker) : undefined,
    rescheduleMeeting: booking ? makeRescheduleMeetingHandler(booker) : undefined,
    cancelMeeting: booking ? makeCancelMeetingHandler(booker) : undefined,
    runCustomApiTool: ({ slug, args }: any) => executeCustomApiTool({ tenantId: opts.tenantId, conversationId: opts.conversationId, slug, args }),
    runCustomDbTool: async ({ slug, args }: any) => {
      const { executeCustomDbQueryTool } = await import("../connectors/custom-db.service");
      return executeCustomDbQueryTool({ tenantId: opts.tenantId, conversationId: opts.conversationId, slug, args });
    },
    runCreateLead: async ({ name, email, phone, company: co, notes }: any) => {
      try {
        const adapter = await getCrmAdapter(opts.tenantId);
        if (adapter.capabilities.is_stub) return { ok: false, reason: "no_crm_configured" };
        const r = await adapter.createLead({ display_name: name, email, phone, company: co, source: "ai_bot", custom: notes ? { notes } : undefined });
        if (r.ok) { try { invalidateCrmPrefetch(opts.tenantId, opts.conversationId); } catch { /* non-fatal */ } return { ok: true, id: r.id, kind: r.kind, vendor: adapter.vendor }; }
        return { ok: false, reason: r.reason || "create_lead_failed" };
      } catch (err: any) {
        return { ok: false, reason: err?.message || "create_lead_failed" };
      }
    },
    runAdapterTool: async ({ toolFunctionName, args: rawArgs }: any) => {
      let args: Record<string, unknown> = rawArgs ?? {};
      if (rawArgs && rawArgs.product_id != null && rawArgs.product_id !== "") {
        let id = resolveProductId(rawArgs.product_id, turnTools.envelope as any, state.offeredItems);
        // A name nothing here knows: find it in the store by that name, once, and take an exact title match.
        const byName = storeSearchByName(toolFunctionName, String(rawArgs.product_id), locale);
        if (!id && byName && !/^PRODUCT_\d+$/i.test(String(rawArgs.product_id))) {
          const found: any = await executeAdapterTool({
            tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: contactRow?.id,
            toolFunctionName: byName.tool, args: byName.args, accessScope: "customer",
          }).catch(() => null);
          const list: any[] = found?.ok && Array.isArray(found.result) ? found.result : [];
          const want = normTitle(rawArgs.product_id);
          const hit = list.find((p) => normTitle(p?.name ?? p?.title) === want) ?? (list.length === 1 ? list[0] : null);
          if (hit?.id != null) id = String(hit.id);
        }
        if (!id) {
          return { ok: false as const, reason: "unknown_product: product_id must be a PRODUCT_n key from THIS turn's results or a store id; search the store by name first. This is not a catalogue failure." };
        }
        args = { ...rawArgs, product_id: id };
      }
      // A state-changing order tool may only touch the order the customer's latest message allows.
      if (isOrderStateChangingTool(toolFunctionName)) {
        const v = assertOrderTargetMatchesTurn({ message: opts.incomingMessage ?? "", args, isStateChanging: true });
        if (!v.ok) return { ok: false as const, reason: `wrong_order: ${v.reason}` };
      }
      if (isComplementaryTool(toolFunctionName)) {
        const gate = await complementaryAnchorAllowed({ tenantId: opts.tenantId, conversationId: opts.conversationId, productId: String(args?.product_id ?? "") });
        if (!gate.ok) return { ok: false as const, reason: gate.reason };
      }
      if (toolFunctionName === WOO_COMPLEMENTARY_TOOL.function.name) {
        if (!wooTurn?.suggestComplementary) return { ok: false as const, reason: "complementary products are off for this widget" };
        const anchorId = String(args?.product_id ?? "").trim();
        if (/^\d{1,12}$/.test(anchorId) && !(await claimCrossSell(opts.conversationId, anchorId))) {
          return { ok: false as const, reason: "the add-ons for this product were already offered in this conversation; do not offer them again" };
        }
        const out = await wooComplementaryProducts(opts.tenantId, anchorId, undefined, { exclude: wooTurn.shown.map((p: any) => p.productId) });
        if (!out.ok || !out.result.length) await releaseCrossSell(opts.conversationId, anchorId);
        return out.ok ? { ok: true as const, result: out.result } : out;
      }
      let effective = await enrichProductSearchArgs({ tenantId: opts.tenantId, conversationId: opts.conversationId, toolName: toolFunctionName, args: args as any });
      if (/^woocommerce\.(list_products|get_product|list_product_variations)$/.test(toolFunctionName)) effective = { ...effective, lang: locale };
      if (toolFunctionName === "woocommerce.list_products") effective = withCustomerSearchFacts(effective, history, opts.incomingMessage ?? "");
      // Shopify parity: the item the customer named and a colour they gave go into its query too
      // (its search takes a query only: sizes, audience and the Hebrew fallback are Woo adapter features).
      if (toolFunctionName === "shopify.search_products") effective = withCustomerQueryWords(effective, history, opts.incomingMessage ?? "");
      // "My orders" are the ones the channel proves: a phone or an email the customer
      // typed is not proof, and the guard refused every such lookup (prod replay 5).
      // Without them the guard supplies the customer's own; with none, the adapter refuses.
      // Orders are read only on a turn about them (prod rating 2026-11-17, Tehila: a "thanks" turn
      // looked up her orders and the reply volunteered one).
      const notAsked = refuseOrderRead(toolFunctionName, opts.incomingMessage ?? "", history);
      if (notAsked) return { ok: false as const, failure: "refused", reason: notAsked } as any;
      const dropped = droppedOrderSelectors(toolFunctionName, effective);
      effective = scrubOrderSelectors(toolFunctionName, effective);
      const out: any = await executeAdapterTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        contactId: contactRow?.id,
        toolFunctionName,
        args: effective,
        accessScope: "customer",
      });
      const asOf = labelInactiveOrders(toolFunctionName, opts.replay ? ordersAsOf(toolFunctionName, out, opts.replay.asOf) : out);
      return dropped ? withOwnNumberNote(asOf) : ownOrderNote(toolFunctionName, asOf);
    },
  };

  // The active business skill (opened via read_skill this turn or kept in state) tightens approval.
  const skillByName = (n: string | null) => skills.find((s) => s.name === n)?.candidate ?? null;
  const env: RunnerEnv = {
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    aiAgentId: config.id,
    lane,
    locale,
    cardChannel,
    ctx,
    skills,
    tightenApproval: (a) => {
      const c = skillByName(turnTools.openedSkill ?? state.activeSkill);
      return c ? skillApprovalReason({ ...c, mode: "on" }, a.tool, (a.args ?? {}) as Record<string, unknown>) : null;
    },
    toolTimeoutMs: cfg.toolTimeoutMs,
    turn: turnTools,
  };

  // ── Prompt ──
  const prefix = buildStablePrefix({
    agent: { name: config.name, role: config.role, roleMission: skills.find((k) => k.source === "role")?.whenToUse ?? null, persona: (config as any).persona, goal: (config as any).goal, successCriteria: (config as any).successCriteria, salesContext: (config as any).salesContext, escalationMessage: config.escalationMessage },
    // The documents' street address too when the profile's has no house number (prod replay 11,
    // Tehila: the profile says only "הסטודיו נמצא בנהריה").
    company: company ? { ...company, documentAddress: profileHasStreet(company.address) ? null : docAddress } : company,
    locale,
    skills,
    channel: String(conversation.channel),
    cardsChannel: cardChannel,
    storePlatform,
  });
  const chat = historyToChat(history);
  const lastRow: any = history.at(-1);
  if (opts.incomingMessage && !(lastRow?.direction === "INBOUND" && String(lastRow.body ?? "").trim() === opts.incomingMessage.trim())) {
    chat.push({ role: "user", content: opts.incomingMessage });
  }
  const windowed = chat.slice(-cfg.windowMessages);
  // What slid out of the window, kept as facts (products shown, the customer's short answers).
  if (chat.length > windowed.length) {
    const earlier = earlierNote(history.slice(0, Math.max(0, history.length - cfg.windowMessages)));
    if (earlier) windowed.unshift({ role: "system", content: earlier });
  }
  const knowledge = buildKnowledgeContext(knowledgeChunks as any, { dropWhenAllWeak: true, conflicts: "team" }) || null;
  const customerName = String((conversation as any).customerName ?? "").trim();
  // A first name only when it reads as one (prod replay 2026-11-17: "היי SharonKampinski").
  const firstName = greetingName(customerName);
  const customerLine = firstName ? `Name: ${firstName}` : null;
  const turnPart = buildTurnPart({
    stateText: renderState(state),
    summary: chat.length > windowed.length ? state.summary : null,
    knowledge,
    page: page ?? null,
    closedHours: closedHoursText(opts.closedHours, locale),
    pendingApprovals: (pendingApprovals as any[]).map((a) => `${a.tool}${a.summary ? `: ${String(a.summary).slice(0, 120)}` : ""}`),
    customer: customerLine,
    activeSkill: (() => {
      const listed = splitInline(skills).listed;
      const k = listed.find((x) => x.name === state.activeSkill);
      return k ? k.render() : null;
    })(),
    nowIso: new Date().toISOString().slice(0, 16),
  });
  // Stable prefix first (cached), then the history, then this turn's facts right before the latest message.
  const last = windowed.pop();
  const messages: any[] = [{ role: "system", content: prefix }, ...windowed, { role: "system", content: turnPart }, ...(last ? [last] : [])];

  // ── Model rounds ──
  let output: ModelTurnOutput | null = null;
  let respondCallId: string | null = null;
  let totalTokens = 0;
  const effort = (process.env.REPLY_ENGINE_EFFORT as any) || "low";
  const call = async (toolChoice: any) => {
    const r = await generateResponse({
      tenantId: opts.tenantId,
      model,
      messages,
      tools: surface.tools,
      toolChoice,
      sessionId: opts.conversationId,
      signal,
      reasoningEffort: effort,
      maxTokens: 1500,
      metadata: { type: lane === "live" ? "ai_bot" : `ai_bot_${lane}`, conversationId: opts.conversationId, aiAgentId: config.id, engine: "v2" } as any,
    });
    trace.rounds++;
    trace.tokens.input += r.usage?.input_tokens ?? 0;
    trace.tokens.output += r.usage?.output_tokens ?? 0;
    trace.tokens.cached += (r.usage as any)?.cached_tokens ?? 0;
    totalTokens += r.usage?.total_tokens ?? 0;
    return r;
  };

  // The whole turn, not only the rewrite, answers inside the budget (prod replay 11: a
  // turn with no rewrite at 22s p95): with little time left the next call must answer,
  // and a tool waits at most what is left minus time for that answer.
  const turnLeft = () => cfg.turnBudgetMs - (Date.now() - t0);
  for (let round = 0; round < cfg.maxRounds && !output; round++) {
    const lastRound = round === cfg.maxRounds - 1 || (round > 0 && turnLeft() < 6000);
    if (lastRound && round < cfg.maxRounds - 1) (trace as any).roundsCut = round;
    const r = await call(lastRound ? { type: "function", function: { name: "respond" } } : "required");
    const calls: ModelToolCall[] = (r.toolCalls ?? []) as any;
    if (!calls.length) {
      // A plain-text answer (a model that ignored tool_choice): take it as the reply.
      if (r.content?.trim()) { const show = takeShowLine(r.content.trim()); output = { reply: show.text, stateUpdate: {}, claims: [], handoff: null, cards: show.keys }; }
      break;
    }
    messages.push({ role: "assistant", content: r.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    const respond = calls.find((c) => c.function?.name === "respond");
    const work = calls.filter((c) => c.function?.name !== "respond");
    if (work.length) {
      const tStart = Date.now();
      await runToolRound({ ...env, toolTimeoutMs: Math.min(env.toolTimeoutMs, Math.max(2000, turnLeft() - 4000)) }, work);
      stageMs[`tools_r${round}`] = Date.now() - tStart;
      for (const c of work) {
        const rec = turnTools.records.find((x) => x.callId === c.id);
        messages.push({ role: "tool", tool_call_id: c.id, content: rec?.content ?? "" });
      }
      if (respond) messages.push({ role: "tool", tool_call_id: respond.id, content: "Not sent: read the tool results above first, then call respond again." });
      continue;
    }
    if (respond) {
      output = parseRespond(respond.function.arguments);
      // One spelling of apostrophes and quotes for every check that follows (prod replay 2026-11-17).
      // A product title as the store writes it, before the checks read the reply (prod rating 2026-11-17).
      if (output) output = { ...output, reply: fixNearTitles(normalizeQuotes(output.reply), (turnTools.envelope?.candidates ?? []).map((c: any) => String(c?.title ?? "")).filter(Boolean)) };
      respondCallId = respond.id;
      if (!output) messages.push({ role: "tool", tool_call_id: respond.id, content: "respond needs a reply string; call it again." });
    }
  }
  mark("model");
  // The model itself reads the message as a forwarded or automated notification, on an email
  // channel: automated mail, answered by no one (prod replay 2026-11-17, a held-out store).
  if (output?.reply && /^(?:EMAIL|GMAIL|OUTLOOK)$/i.test(String(conversation.channel ?? "")) && MODEL_SAYS_AUTOMATED.test(output.reply)) {
    trace.gate1 = "automated:model_framed";
    (trace as any).automated = "model_framed";
    trace.gate3 = { ok: true, problems: [], rewrite: "none" };
    return empty({ reply: null });
  }

  // ── Gate 3 ──
  let candidates = turnTools.envelope?.candidates ?? [];
  // Recomputed: what the rewrite's lookups return is grounding too.
  const groundingNow = () => [
    ...turnTools.records.map((r) => r.content),
    JSON.stringify((turnTools.envelope?.candidates ?? []).map((c: any) => ({ title: c.title, price: c.price, currency: c.currency }))),
    renderState(state),
    knowledge ?? "",
    ...turnTools.knowledgeText,
    ...chat.filter((m) => m.role === "user").map((m) => m.content),
  ].join("\n");
  const approvalPending = turnTools.approvals.length > 0;
  // A question the team already has from this conversation (prod replay 2026-11-16:
  // one damaged-delivery thread recorded the same question on 8 turns in a row).
  const openTeam = openTeamQuestions(state);
  const teamAlreadyOpen = openTeam.length > 0;
  const isNewTeamQuestion = (q: string | null | undefined) => !!q && !openTeam.some((t) => sameIssue(t, q));
  // The employee's own earlier replies (never a person's): repeated asks, a "yes" to its own offer.
  // Once a safety or damage complaint is seen, the conversation stays one (prod replay 11:
  // the tipping complaint had left the window when "it doesn't stop it rolling back" came).
  const safetySince = Date.parse(String(state.facts?.[SAFETY_FACT] ?? ""));
  const safetyConversation = (Number.isFinite(safetySince) && Date.now() - safetySince < TEAM_OPEN_MS) || safetyCase(inbound.slice(-10), [knowledge ?? "", ...turnTools.knowledgeText].join("\n"));
  const previousBotReplies = history
    .filter((m: any) => m.direction === "OUTBOUND" && !isPersonOutbound(m) && String(m.body ?? "").trim() && !/product|system/.test(String(m.messageType ?? "")) && !["interim_ack", "holding"].includes((m.metadata as any)?.kind))
    .map((m: any) => String(m.body)).slice(-6);
  const g3Input = (o: ModelTurnOutput) => ({
    reply: resolveKeysInText(o.reply, candidates),
    claims: o.claims,
    cards: o.cards ?? [],
    candidateCount: candidates.length,
    tools: turnTools.records,
    grounding: groundingNow(),
    locale,
    incomingMessage: opts.incomingMessage ?? "",
    isFirstReply: !history.some((m: any) => m.direction === "OUTBOUND"),
    employeeGender: (config as any).persona?.gender === "female" ? "feminine" as const : (config as any).persona?.gender === "male" ? "masculine" as const : null,
    employeeName: config.name,
    toolsOffered: surface.names,
    shopFloor: !!storePlatform,
    handedOff: !!o.handoff || !!turnTools.escalation,
    // A team question is real follow-up work: "we'll check with the team" is then true.
    approvalPending: approvalPending || !!o.teamQuestion,
    handoff: o.handoff ?? null,
    teamQuestion: !!o.teamQuestion,
    teamAlreadyOpen,
    newTeamQuestion: isNewTeamQuestion(o.teamQuestion),
    recentInbound: inbound,
    toolsNeedPerson: approvalPending || turnTools.records.some((r) => r.decision === "deny"),
    knowledge: [knowledge ?? "", ...turnTools.knowledgeText].join("\n"),
    previousBotReplies,
    candidateTitles: candidates.map((c: any) => String(c?.title ?? "")).filter(Boolean),
    cardsChannel: cardChannel,
    listAppended: !cardChannel && candidates.length > 0,
    customerText: inbound.join("\n"),
    openTeamText: openTeam.join("\n"),
    knownInactiveOrders: String(state.facts?.[INACTIVE_ORDERS_FACT] ?? "").split(",").filter(Boolean),
    candidatePrices: candidates.map((c: any) => ({ title: String(c?.title ?? ""), price: c?.price != null && !c?.priceOnSite ? Number(c.price) : null })).filter((c: any) => c.title),
    onOpenItem: openTeam.some((t) => sameIssue(t, String(opts.incomingMessage ?? ""))),
    safety: safetyConversation,
    searchFailed: turnTools.records.some((r) => /list_products|search_products/.test(r.tool) && (r.outcome === "timeout" || r.outcome === "error")),
    businessAddress: [company?.address, profileHasStreet(company?.address) ? null : docAddress].filter(Boolean).join("; ") || null,
    // Everything but the customer's own words: tools, products, state, knowledge, a person's lines.
    sourceText: [
      ...turnTools.records.map((r) => r.content),
      JSON.stringify((turnTools.envelope?.candidates ?? []).map((c: any) => c.title)),
      renderState(state), knowledge ?? "", ...turnTools.knowledgeText,
      ...chat.filter((m) => m.role === "user" && /^\[(?:Human team member|The business owner)/.test(String(m.content))).map((m) => m.content),
    ].join("\n"),
  });

  let escalation: AIBotReplyResult["escalation"] = turnTools.escalation as any;
  let verdict = output ? gate3(g3Input(output)) : { ok: false, problems: [{ kind: "style" as const, codes: ["empty"] }] };
  // The canned team line goes out at most once per conversation (prod replay 2:
  // it replaced real answers turn after turn). Ours in the history, or the state's mark.
  const cannedSent = !!state.facts?.[CANNED_SENT_FACT] || history.some((m: any) => m.direction === "OUTBOUND" && isCannedTeamLine(m.body));
  let cannedNow = false;
  (trace as any).rewriteRounds = 0;
  if (!verdict.ok) {
    // ONE targeted rewrite, at most TWO more model calls (prod replay 5: p95 17s).
    if (respondCallId) messages.push({ role: "tool", tool_call_id: respondCallId, content: correctionNote(verdict.problems, locale) });
    else messages.push({ role: "system", content: correctionNote(verdict.problems, locale) });
    const first = verdict;
    const original = output;
    let second: ModelTurnOutput | null = null;
    // The customer is waiting (prod replay 6: a one-round rewrite at p95 27s). The
    // rewrite fits in what is left of the turn's budget, or is skipped and the
    // reply is cleaned in code instead.
    const left = () => cfg.turnBudgetMs - (Date.now() - t0);
    const rewriteCall = async (choice: any) => {
      (trace as any).rewriteRounds++;
      const deadline = Math.max(3000, left());
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), deadline); });
      const r = await Promise.race([call(choice), late]).finally(() => clearTimeout(timer));
      if (!r) { (trace as any).rewriteCut = "deadline"; throw Object.assign(new Error("rewrite past the turn budget"), { name: "RewriteDeadline" }); }
      return r;
    };
    try {
      const forceRespond = { type: "function", function: { name: "respond" } };
      if (left() < 4000) { (trace as any).rewriteCut = "budget"; throw Object.assign(new Error("no time left for a rewrite"), { name: "RewriteDeadline" }); }
      // The lookups the engine can make itself run first, with no model round:
      // the customer's own words in the store, or in the knowledge. Short, and only with time for an answer after.
      const auto = left() > 8000 ? autoLookups(first.problems, opts.incomingMessage ?? "", surface.names, turnTools.records) : [];
      if (auto.length) {
        const ta = Date.now();
        messages.push({ role: "assistant", content: "", tool_calls: auto.map((c) => ({ id: c.id, type: "function", function: c.function })) });
        await runToolRound({ ...env, toolTimeoutMs: Math.min(env.toolTimeoutMs, cfg.rewriteLookupMs) }, auto);
        for (const c of auto) messages.push({ role: "tool", tool_call_id: c.id, content: turnTools.records.find((x) => x.callId === c.id)?.content ?? "" });
        candidates = turnTools.envelope?.candidates ?? [];
        (trace as any).autoLookupMs = Date.now() - ta;
      }
      // A lookup only the model can make (which product, which order) gets one tool round, if there is time for two calls.
      const modelRead = left() > 9000 && first.problems.some((p) => p.kind === "unread_product" || p.kind === "unread_order" || (!auto.length && (p.kind === "unread_knowledge" || p.kind === "gave_up_search" || p.kind === "ungrounded_absence" || p.kind === "no_search")));
      let r = await rewriteCall(modelRead ? "required" : forceRespond);
      if (modelRead) {
        const calls: ModelToolCall[] = (r.toolCalls ?? []) as any;
        const work = calls.filter((c) => c.function?.name !== "respond");
        if (work.length) {
          messages.push({ role: "assistant", content: r.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
          await runToolRound({ ...env, toolTimeoutMs: Math.min(env.toolTimeoutMs, cfg.rewriteLookupMs) }, work);
          for (const c of calls) {
            const rec = turnTools.records.find((x) => x.callId === c.id);
            messages.push({ role: "tool", tool_call_id: c.id, content: rec?.content ?? "Not sent: read the results first." });
          }
          candidates = turnTools.envelope?.candidates ?? [];
          r = await rewriteCall(forceRespond);
        }
      }
      const rc = (r.toolCalls ?? []).find((c: any) => c.function?.name === "respond");
      second = rc ? parseRespond(rc.function.arguments) : null;
      if (second) second = { ...second, reply: fixNearTitles(normalizeQuotes(second.reply), (turnTools.envelope?.candidates ?? []).map((c: any) => String(c?.title ?? "")).filter(Boolean)) };
    } catch (err: any) {
      if ((err as any)?.name === "AbortError") throw err;
      second = null;
    }
    (trace as any).rewriteMs = Date.now() - t0 - (stageMs.model ?? 0);
    const v2 = second ? gate3(g3Input(second)) : null;
    if (second && v2?.ok) {
      output = second; verdict = v2; trace.gate3 = { ...first, rewrite: "rewritten" };
    } else {
      // Not clean: what is left is cleaned and sent. A FACT problem (a price, a
      // product, an absence or an action no tool backs) loses its sentence; the
      // rest goes out if it still answers. The rewrite first, else the original.
      const salvage = (o: ModelTurnOutput | null) => {
        if (!o) return null;
        const v = gate3(g3Input(o));
        const codes = v.problems.flatMap((p) => (p.kind === "style" ? p.codes : []));
        const needless = v.problems.some((p) => p.kind === "needless_handoff");
        const handoff = needless ? null
          : v.problems.some((p) => p.kind === "ignored_yes") ? "the customer accepted the offer of a person"
          : o.handoff;
        let facts = stripFactProblems(resolveKeysInText(o.reply, candidates), v.problems);
        // A handoff removed as needless takes its words with it (prod replay 2026-11-17, Smoovee: "העברנו
        // את הבדיקה לצוות ונמשיך כאן" went out with neither): "a person continues" is cut, and "passed to
        // the team" becomes true by recording the question for the team (or is cut when one is open).
        let teamQ = o.teamQuestion ?? null;
        if (needless && o.handoff) {
          facts = dropPersonPromises(facts);
          if (teamLineIn(facts) && !teamQ) {
            if (!teamAlreadyOpen) teamQ = String(opts.incomingMessage ?? "").slice(0, 300) || o.handoff;
            else facts = removeTeamLines(facts);
          }
        }
        const cleaned: ModelTurnOutput = { ...o, teamQuestion: teamQ, reply: cleanStyle(facts, codes, previousBotReplies, inbound.join("\n"), opts.incomingMessage ?? "", candidates.map((c: any) => String(c?.title ?? "")).filter(Boolean), config.name ?? null), handoff, cards: (o.cards ?? []).filter((k) => { const n = Number(/PRODUCT_(\d+)/i.exec(k)?.[1]); return n >= 1 && n <= candidates.length; }) };
        // The same paragraph again is never sent (prod replay 6: seven times in one conversation).
        if (codes.includes("near_duplicate") && gate3(g3Input({ ...o, reply: cleanStyle(stripFactProblems(resolveKeysInText(o.reply, candidates), v.problems), codes, [], inbound.join("\n")) })).problems.some((p) => p.kind === "style" && p.codes.includes("near_duplicate"))) return null;
        if (!cleaned.reply) return null;
        const after = gate3(g3Input(cleaned));
        if (factualProblems(after.problems).length) return null;
        // A remnant that no longer answers (prod replay 9: "ההכוונה הקודמת לא הייתה נכונה." alone on a safety
        // complaint) is kept only as the last resort, never as the answer while the model can still give one.
        const removed = removedSentences(resolveKeysInText(o.reply, candidates), cleaned.reply);
        const thin = tooThin(cleaned.reply, o.reply, opts.incomingMessage ?? "", { cards: cleaned.cards ?? [], titles: candidates.map((c: any) => c?.title).filter(Boolean) });
        // Hollow: thin, or most of the reply cut away (a style edit keeps its words).
        const hollow = thin || (wordCount(cleaned.reply) < 8 && wordCount(cleaned.reply) < 0.6 * wordCount(o.reply));
        return { o: cleaned, v: after, hollow, thin, removed, problems: v.problems };
      };
      const fromSecond = salvage(second);
      const fromOriginal = salvage(original);
      // A recommendation ask: the version that picks a product is kept over one that does not
      // (prod replay 2026-11-17, Urban: the rewrite dropped the pick).
      const wantsPick = first.problems.some((p) => p.kind === "no_recommendation");
      const order = wantsPick ? [fromSecond, fromOriginal].sort((a, b) => Number(!!b && picksProduct(b.o.reply)) - Number(!!a && picksProduct(a.o.reply))) : [fromSecond, fromOriginal];
      let kept = order.find((x) => x && !x.hollow) ?? null;
      if (!kept && (fromSecond || fromOriginal || second || original) && left() > 5000) {
        // ONE targeted rewrite: what was cut and why, and answer the customer fully.
        const cut = (fromSecond ?? fromOriginal);
        const why = [...new Set((cut?.problems ?? v2?.problems ?? first.problems).map((p) => p.kind === "style" ? p.codes.join("/") : p.kind))].join(", ");
        messages.push({ role: "system", content: `Your reply could not be sent as written${cut?.removed.length ? `: these sentences had to be cut (${why}): ${cut.removed.map((x) => `"${x.slice(0, 160)}"`).join(" ")}` : ` (${why})`}. What was left does not answer the customer's last message: "${String(opts.incomingMessage ?? "").slice(0, 300)}". Write the full answer to it now, without those claims, and call respond.` });
        try {
          const r3 = await rewriteCall({ type: "function", function: { name: "respond" } });
          const rc3 = (r3.toolCalls ?? []).find((c: any) => c.function?.name === "respond");
          const third = rc3 ? parseRespond(rc3.function.arguments) : null;
          const s3 = salvage(third);
          if (s3 && !s3.hollow) { kept = s3; (trace as any).rewrite2 = true; }
        } catch (err: any) {
          if ((err as any)?.name === "AbortError") throw err;
        }
      }
      // Else the original minus only its offending sentences, then the rewrite's remnant.
      // (A product turn with products found keeps its grounded product fallback instead.)
      // A thin remnant ("תודה!" for a question) is never the answer.
      if (!kept && !(productAskNow(opts.incomingMessage ?? "") && groundedProductFallback(candidates as any, locale, cardChannel))) kept = [fromOriginal, fromSecond].find((x) => x && !x.thin) ?? null;
      if (kept) {
        output = kept.o; verdict = kept.v; trace.gate3 = { ...first, rewrite: kept.hollow ? "cleaned_partial" : "cleaned" };
      } else {
        verdict = v2 ?? first;
        trace.gate3 = { ...first, rewrite: "fallback" };
        const factLeft = factualProblems((v2 ?? first).problems).map((p) => p.kind);
        (trace as any).fallbackKinds = factLeft.length ? factLeft : ["thin_or_empty"];
        // A product turn is answered from what the tools returned, never handed to a person.
        // Products as the fallback only for a product ask (prod replay 2026-11-17: a payment problem got cards).
        // The header only, on every channel: cards show the products, and on a text channel the list
        // appended at send names each one once with its price, stock and link (prod replay 2026-11-17:
        // inline bullets AND the same three listed again).
        const grounded = productAskNow(opts.incomingMessage ?? "") ? groundedProductFallback(candidates as any, locale, true) : null;
        const question = String(opts.incomingMessage ?? "").slice(0, 300) || null;
        const searched = turnTools.records.some((t) => /list_products|search_products/.test(t.tool) && (t.outcome === "ok" || t.outcome === "empty"));
        const onlyRepeat = !factLeft.length && first.problems.some((p) => p.kind === "style" && p.codes.includes("near_duplicate"));
        // A question is never answered with silence (prod rating 2026-11-17, Smoovee A: a coupon question):
        // the team line once, then one holding line, then nothing more.
        const asked = asksSomething(opts.incomingMessage ?? "");
        const holding = stillCheckingLine(opts.incomingMessage ?? "", locale === "en" ? "en" : "he");
        const lastOutBody = String([...history].reverse().find((m: any) => m?.direction === "OUTBOUND")?.body ?? "").trim();
        const questionLine = (): { reply: string; teamQuestion: string | null } =>
          !cannedSent ? { reply: safeFallback(locale, teamAlreadyOpen), teamQuestion: teamAlreadyOpen ? null : question }
            : { reply: lastOutBody === holding ? "" : holding, teamQuestion: question };
        if (onlyRepeat && !productAskNow(opts.incomingMessage ?? "") && asked) {
          const q = questionLine();
          output = { reply: q.reply, stateUpdate: {}, claims: [], handoff: null, teamQuestion: q.teamQuestion, cards: [] };
          if (!cannedSent) cannedNow = true;
          if (!q.reply) trace.gate3 = { ...first, rewrite: "silent" };
        } else if (onlyRepeat && !productAskNow(opts.incomingMessage ?? "")) {
          // Nothing new to say: say nothing rather than the same paragraph or a canned line.
          // Never on a product ask (prod replay 2026-11-17, Tehila): that one gets the products or a question.
          output = { reply: "", stateUpdate: {}, claims: [], handoff: null, cards: [] };
          trace.gate3 = { ...first, rewrite: "silent" };
        } else if (!grounded && searched && first.problems.some((p) => p.kind === "ungrounded_absence") && needlessHandoff("reply_failed_checks", inbound, approvalPending)
          // Only a product ask whose named item the search really did not find (prod replay 2026-11-17: on a
          // stopper or coupon question, with the model in the results).
          && productAskNow(opts.incomingMessage ?? "") && !namedInResults(String(opts.incomingMessage ?? ""), candidates)) {
          output = { reply: notFoundReply(locale), stateUpdate: {}, claims: [], handoff: null, cards: [] };
        } else if (grounded) {
          output = { reply: grounded, stateUpdate: {}, claims: [], handoff: null, cards: candidates.map((c: any, i: number) => ({ c, i })).filter((x: any) => x.c?.title && x.c.inventoryState !== "out_of_stock").slice(0, 3).map((x: any) => `PRODUCT_${x.i + 1}`) };
        } else if (productAskNow(opts.incomingMessage ?? "") && (state.offeredItems?.length ?? 0) > 0 && needlessHandoff("reply_failed_checks", inbound, approvalPending)) {
          // A simple product ask with nothing grounded to show: one question that moves the choice on,
          // never a question for the team (prod replay 2026-11-17: "רוצה לבן" sent to the team).
          output = { reply: productQuestionLine(locale), stateUpdate: {}, claims: [], handoff: null, cards: [] };
        } else if (!needlessHandoff("reply_failed_checks", inbound, approvalPending)) {
          // The customer's words call for a person (asked for one, damage, a late order).
          output = { reply: cannedSent ? "" : safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };
          cannedNow = !cannedSent;
        } else if (!cannedSent) {
          // Nothing calls for a person: a question for the team, and the AI keeps the chat.
          output = { reply: safeFallback(locale, teamAlreadyOpen), stateUpdate: {}, claims: [], handoff: null, teamQuestion: teamAlreadyOpen ? null : question, cards: [] };
          cannedNow = true;
        } else if (productAskNow(opts.incomingMessage ?? "")) {
          // Never silent on a product ask (prod replay 2026-11-17, Tehila): one question that moves the
          // choice on, and the question still reaches the team.
          output = { reply: productQuestionLine(locale), stateUpdate: {}, claims: [], handoff: null, teamQuestion: question, cards: [] };
        } else if (asked) {
          // The canned line already went out: a question still gets one holding line (not twice in a row).
          const q = questionLine();
          output = { reply: q.reply, stateUpdate: {}, claims: [], handoff: null, teamQuestion: q.teamQuestion, cards: [] };
          if (!q.reply) trace.gate3 = { ...first, rewrite: "silent" };
        } else {
          // The canned line already went out once: nothing new to say. The question
          // still reaches the team (once per issue) so the owner sees it.
          output = { reply: "", stateUpdate: {}, claims: [], handoff: null, teamQuestion: question, cards: [] };
          trace.gate3 = { ...first, rewrite: "silent" };
        }
      }
    }
  } else {
    trace.gate3 = { ...verdict, rewrite: "none" };
  }
  mark("gate3");
  // Last line of defence, on every path: a price nothing grounds (prod replay 4),
  // and a character from another alphabet (prod replay 5: "כשמ折לים").
  // A turn on a held subject (holding mode): no new team item may be opened for it.
  let heldTurn = false;
  let heldMerged = false;
  if (output?.reply) {
    const titles = candidates.map((c: any) => String(c?.title ?? "")).filter(Boolean);
    // No price sentence left without its product (prod rating 2026-11-17).
    let text = dropDanglingPrice(normalizeDashes(stripForeignScript(resolveKeysInText(output.reply, candidates), inbound.join("\n"))), titles);
    // A first name only from the profile or the customer's own signature (prod rating 2026-11-17: "היי אלה").
    text = dropUnaskedName(text, [firstName, ...signedNames(inbound)]);
    // Holding mode (prod rating 2026-11-17): a sensitive team item is open; nothing about its state, cause or
    // outcome goes out, only the acknowledgement and the holding line. A question on anything else is answered.
    const held = output.handoff ? null : holdingItem(openTeam);
    if (held) {
      const incomingNow = String(opts.incomingMessage ?? "");
      const lastInMsg: any = [...history].reverse().find((m: any) => m?.direction === "INBOUND");
      const details = bringsDetails(incomingNow, /image|document|video|audio|sticker|file/i.test(String(lastInMsg?.messageType ?? "")));
      // A nudge: a short message that asks nothing of its own ("נו?" asks, "מתי אתם פתוחים?" is a question).
      const nudge = incomingNow.trim().split(/\s+/).length <= 3 && (!asksSomething(incomingNow) || /^\s*(?:נו|nu|\?+|so|any news|יש חדש|מה קורה)\s*\??\s*$/iu.test(incomingNow));
      const onSubject = details || aboutHeld(incomingNow) || statusAsk(incomingNow) || nudge;
      const subjectTurn = onSubject || aboutHeld(text);
      if (subjectTurn) {
        const holdLoc: "he" | "en" = locale === "en" ? "en" : "he";
        text = onSubject
          ? holdReply(text, stillCheckingLine(held, holdLoc), { details, locale: holdLoc })
          : (holdReply(text, "", { details: false, locale: holdLoc }) || stillCheckingLine(held, holdLoc));
        (trace as any).holding = { details };
        // No new team item on the held subject: the open one holds it, and the details go there
        // (prod rating 2026-11-17: "4 ספרות אחרונות 4155" opened a second item instead).
        heldTurn = onSubject;
        if (onSubject && output.teamQuestion) { output = { ...output, teamQuestion: null }; heldMerged = true; (trace as any).holding.teamQuestionMerged = true; }
      }
    }
    const leftover = ungroundedPrices(text, groundingNow());
    if (leftover.length) (trace as any).priceStripped = leftover.length;
    output = { ...output, reply: (leftover.length ? stripPrices(text, leftover) : text).trim() };
  }
  // Never a promise of a person without the handoff (prod replay 6): a reply that says
  // a person will continue, or a "yes" to the employee's own offer of one, hands over.
  // A yes to the employee's own offer (its last two replies) gets THE handoff line,
  // whatever the model wrote (prod replay 7: a coupon explained again; a product
  // question with the handoff set).
  // The lines the engine adds are in the reply's own language (eval 2026-11-17: an English line
  // inside a Hebrew reply when the customer's last words were Latin, a product name or "ok").
  const lineLocale: "he" | "en" = output?.reply && /[\u0590-\u05FF]/.test(output.reply) ? "he" : output?.reply && /[A-Za-z]{2,}/.test(output.reply) && !/[\u0590-\u05FF]/.test(output.reply) ? "en" : locale;
  const handoffLine = lineLocale === "he" ? "מעבירים לנציג מהצוות שימשיך איתך כאן." : "A person from the team will continue with you here.";
  if (output && !turnTools.escalation) {
    const accepted = previousBotReplies.slice(-2).some((b) => ignoredYes(opts.incomingMessage ?? "", b, false, false));
    if (accepted) {
      if (!output.handoff || output.reply !== handoffLine) (trace as any).handoffSetInCode = true;
      output = { ...output, handoff: output.handoff ?? "the customer accepted the offer of a person", reply: handoffLine, cards: [], teamQuestion: null };
    } else if (!output.handoff && promisesPerson(output.reply)) {
      output = { ...output, handoff: "the reply says a person will continue", reply: isCannedTeamLine(output.reply) || !output.reply ? handoffLine : output.reply };
      (trace as any).handoffSetInCode = true;
    }
  }
  // A safety or damage complaint in the customer's last 10 messages never ends without a
  // person or the team (prod replay 9: "ההכוונה הקודמת לא הייתה נכונה." alone on one).
  if (output && !output.handoff && !output.teamQuestion && !turnTools.escalation && safetyConversation) {
    output = { ...output, handoff: "safety or damage in the conversation", reply: promisesPerson(output.reply) ? output.reply : [output.reply?.trim(), handoffLine].filter(Boolean).join(" ") };
    (trace as any).handoffSetInCode = true;
    (trace as any).safetyHandoff = true;
  }
  // The stop-use advice only when THIS turn is about the product in use (prod replay 12: added to
  // a collaboration inquiry). A sticky safety conversation still hands over (above).
  (trace as any).safetyWord = safetyWord(inbound.slice(-10));
  if (output?.reply && safetyConversation && !hasStopUse(output.reply) && customerDescribesUse(String(opts.incomingMessage ?? ""), [knowledge ?? "", ...turnTools.knowledgeText].join("\n")) && !hasStopUse(previousBotReplies.at(-1) ?? "")) {
    output = { ...output, reply: `${output.reply.trim()} ${lineLocale === "he" ? "עד שנציג מהצוות יבדוק, מומלץ להפסיק להשתמש בזה." : "Until a person from the team checks it, it is best to stop using it."}` };
    (trace as any).stopUseAdded = true;
  }
  // "Already with the team" only for the SAME subject as an open team item (prod replay 9: a
  // colour ask told "זה כבר אצל הצוות" when the open item was a coupon): else this ask is recorded.
  // Every subject the customer raised, not only the message as a whole (prod replay 2026-11-17: white AND
  // a coupon, only the coupon open, and "the check on white and the coupon is still open").
  const uncovered = teamAlreadyOpen ? uncoveredSubjects(String(opts.incomingMessage ?? ""), openTeam) : [];
  if (output?.reply && !output.handoff && !output.teamQuestion && !heldTurn && teamAlreadyOpen && teamLineIn(output.reply) && !statusAsk(opts.incomingMessage ?? "") && uncovered.length) {
    output = { ...output, teamQuestion: uncovered.join("; ").slice(0, 300) || null, reply: isCannedTeamLine(output.reply) ? safeFallback(locale) : output.reply };
    (trace as any).newSubjectToTeam = true;
  }
  // A call request is never ignored (prod replay 8): there is no call tool, so it goes to the team.
  if (output?.reply && !output.handoff && !output.teamQuestion && !turnTools.escalation && CALL_REQUEST.test(opts.incomingMessage ?? "")) {
    output = { ...output, teamQuestion: `call request: ${String(opts.incomingMessage ?? "").slice(0, 260)}`, reply: teamPassIn(output.reply) ? output.reply : `${output.reply.trim()} ${lineLocale === "he" ? "העברתי לצוות את הבקשה לשיחה, והתשובה תגיע כאן בצ'אט." : "I've passed your call request to the team, and the answer will come here in the chat."}` };
    (trace as any).callToTeam = true;
  }
  // An open complaint answered "no information" with nothing behind it (prod replay 7):
  // the question goes to the team, and the reply says so.
  if (output?.reply && !output.handoff && !output.teamQuestion && !turnTools.escalation && noInfo(output.reply) && !needlessHandoff("x", inbound, false)) {
    const q = String(opts.incomingMessage ?? "").slice(0, 300) || null;
    output = { ...output, teamQuestion: q, reply: teamPassIn(output.reply) ? output.reply : `${output.reply.trim()} ${lineLocale === "he" ? "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט." : "I've passed this to the team, and the answer will come here in the chat."}` };
    (trace as any).deadEndToTeam = true;
  }
  // A payment or checkout failure is a support case: no cards, no product list (prod replay 2026-11-17).
  const payProblem = paymentProblem(opts.incomingMessage ?? "");
  if (output && payProblem && (output.cards ?? []).length) output = { ...output, cards: [] };
  // A product search that failed with nothing found, two turns in a row: the team takes the question
  // (prod replay 2026-11-17: empty promises and "try another name" instead).
  const searchFailedNow = turnTools.records.some((r) => /list_products|search_products/.test(r.tool) && (r.outcome === "timeout" || r.outcome === "error"))
    && !turnTools.records.some((r) => /list_products|search_products|get_product/.test(r.tool) && (r.outcome === "ok" || r.outcome === "empty"));
  const lastFail = Date.parse(String(state.facts?.[SEARCH_FAIL_FACT] ?? ""));
  if (output?.reply && searchFailedNow && Number.isFinite(lastFail) && Date.now() - lastFail < 30 * 60_000 && !output.handoff && !output.teamQuestion && !turnTools.escalation) {
    output = { ...output, teamQuestion: `product search failed twice: ${String(opts.incomingMessage ?? "").slice(0, 260)}`, reply: teamPassIn(output.reply) ? output.reply : `${output.reply.trim()} ${locale === "he" ? "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט." : "I've passed this to the team, and the answer will come here in the chat."}` };
    (trace as any).searchFailTwiceToTeam = true;
  }
  // A team question is a short subject plus the ask, never the raw message alone, and a status ask
  // ("יש חדש?") on an open item is no new question (prod replay 2026-11-17).
  if (output?.teamQuestion) {
    const q = teamQuestionText(output.teamQuestion, String(opts.incomingMessage ?? ""), state, openTeam);
    output = { ...output, teamQuestion: q };
  }
  // A question recorded for the team this turn is told to the customer, naming it (prod replay 2026-11-17).
  // Not when the reply offers to ask instead ("Would you like me to ask?"): one or the other, never both.
  if (output?.reply && output.teamQuestion && isNewTeamQuestion(output.teamQuestion) && !output.handoff && !teamPassIn(output.reply) && !offersToAsk(output.reply) && !/(?<![\u0590-\u05FF])(?:בבדיקה|בודק|בודקים)(?![\u0590-\u05FF])|\bbeing checked\b/iu.test(output.reply)) {
    // A fixed line: the team question is internal text and is never quoted (prod replay 2026-11-17:
    // a third-person, cut-off question was read to the customer).
    output = { ...output, reply: `${output.reply.trim()} ${locale === "he" ? "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט." : "I've passed this to the team, and the answer will come here in the chat."}` };
    (trace as any).teamQuestionTold = true;
  }
  // The customer is back on a subject the team already has (prod replay 2026-11-17, NE'A): say it is
  // with the team, naming it, when the reply does not.
  const openOnIt = openTeam.find((t) => sameIssue(t, String(opts.incomingMessage ?? "")));
  if (output?.reply && openOnIt && !output.handoff && !teamPassIn(output.reply) && !offersToAsk(output.reply) && !/(?<![\u0590-\u05FF])(?:אצל|בבדיקה|בודק|בודקים)(?![\u0590-\u05FF])|\b(?:with the team|being checked)\b/iu.test(output.reply)) {
    output = { ...output, reply: `${output.reply.trim()} ${stillCheckingLine(openOnIt, locale)}` };
    (trace as any).openItemMentioned = true;
  }
  // The engine's own team line at most once per conversation (prod replay 2026-11-17, Tehila: twice in a
  // row): the second time it names what is being checked instead.
  const canned = output?.reply ? endsWithCannedTeamLine(output.reply) : null;
  const cannedBefore = cannedSent || history.some((m: any) => m.direction === "OUTBOUND" && !!endsWithCannedTeamLine(m.body));
  if (output?.reply && canned && cannedBefore) {
    const named = stillCheckingLine(String(output.teamQuestion ?? openTeam.at(-1) ?? opts.incomingMessage ?? ""), locale);
    const head = output.reply.slice(0, output.reply.length - canned.length).trim();
    output = { ...output, reply: head ? `${head} ${named}` : named };
    (trace as any).cannedRenamed = true;
  } else if (output?.reply && canned) cannedNow = true;
  // A raw handle or a full username in the greeting goes (the name line now carries only a first name).
  if (output?.reply && customerName && !firstName && output.reply.includes(customerName)) {
    output = { ...output, reply: output.reply.replace(new RegExp(`\\s*,?\\s*${customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?=[,!.]|$)`, "u"), "").replace(/^(\S+)\s*,\s*/u, "$1, ").trim() };
  }
  // Never the same sentence twice in one reply (prod replay 12: the stop-use line twice).
  if (output?.reply) output = { ...output, reply: dedupeSentences(output.reply) };
  const final: ModelTurnOutput = output ?? { reply: cannedSent ? "" : safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };
  (trace as any).cards = final.cards ?? [];

  // ── Send shape ──
  // A semicolon reads as a document; legacy banned it (eval I05). Fixed, not rewritten.
  const prose = stripLaterOpener(
    (humanizeReply(resolveKeysInText(final.reply, candidates)) ?? "").replace(/\s*;\s*/g, ", "),
    history.some((m: any) => m.direction === "OUTBOUND"),
  );
  // A text channel (WhatsApp) shows no cards: the products the reply means go out
  // as text, name, price, stock and link, at most three (prod replay 7: Smoovee had
  // no card and no link on 56 turns; the product summary tells the model the
  // system attaches them, and legacy did).
  // Products are listed for a product ask only (prod replay 2026-11-17: a coupon question got a list).
  const listed = !cardChannel && prose && !final.handoff && !payProblem && productAskNow(opts.incomingMessage ?? "") ? textProductList(final, prose, candidates, /[\u0590-\u05FF]/.test(prose) ? "he" : locale) : null;
  // The model's text is sanitized as the very last step (prod replay 13: "+#+#+#+#+#+" at the
  // end of a reply); the appended list is the store's exact fields and is left as it is.
  const clean = sanitizeReply(prose);
  if (clean !== prose) (trace as any).sanitized = true;
  // One message, no product twice and no line twice (prod replay 2026-11-17, both Smoovee runs).
  const reply = assembleOnce(clean, listed?.text ?? null, candidates.map((c: any) => String(c?.title ?? "")).filter(Boolean));
  if (listed) (trace as any).listedProducts = listed.keys;
  const offered: OfferedItem[] = [];
  const now = new Date().toISOString();
  const cardKeys = (final.cards ?? []).map((k) => Number(/PRODUCT_(\d+)/i.exec(k)?.[1])).filter((n) => n >= 1 && n <= candidates.length);
  if (cardKeys.length && cardChannel && lane === "live") {
    const picked = [...new Set(cardKeys)].slice(0, 6).map((n) => candidates[n - 1]);
    try {
      await productTurn.sendShopifyProducts({ products: picked.map((c: any) => ({ productId: c.productId, variantId: c.variantId })) });
    } catch (err: any) {
      console.warn(`[reply-engine] card staging failed conv=${opts.conversationId}:`, err?.message);
    }
  }
  // What the customer was shown or told about this turn becomes "already shown".
  const named = new Set<number>(cardKeys);
  candidates.forEach((c: any, i: number) => { if (c?.title && reply.includes(c.title)) named.add(i + 1); });
  for (const n of named) {
    const c: any = candidates[n - 1];
    if (c) offered.push({ ref: `id:${c.productId}`, title: c.title, price: c.price ?? null, currency: c.currency ?? null, productId: c.productId ?? null, variantId: c.variantId ?? null, at: now });
  }

  if (final.handoff && !escalation) {
    escalation = { reason: `ai_handoff:${final.handoff.slice(0, 80)}`, priority: "medium", summary: final.handoff.slice(0, 300) } as any;
  }
  const firstApproval = turnTools.approvals[0];
  const awaitingApproval = lane === "live" && firstApproval
    ? { approvalRequestId: firstApproval.approvalRequestId, tool: firstApproval.tool, reason: "requires_approval" }
    : null;

  // A question for the team: on the owner's unanswered list, and an open promise in
  // the state. ONCE per open issue: a repeat of the open one is not recorded again.
  const newTeamQuestion = isNewTeamQuestion(final.teamQuestion) ? final.teamQuestion! : null;
  trace.teamQuestion = newTeamQuestion;
  trace.teamQuestionRepeat = (!!final.teamQuestion && !newTeamQuestion) || heldMerged;
  // A repeat that brings new details (digits the customer gave: a card's last four, an order number)
  // updates the open item instead of being skipped (prod replay 2026-11-17: "4155" lost).
  let pendingNow = state.pending;
  // In holding mode the customer's new details go to the held item even when the model asked nothing.
  const heldItem = holdingItem(openTeam);
  const detailsFor = final.teamQuestion && !newTeamQuestion ? final.teamQuestion : !final.teamQuestion && heldItem ? heldItem : null;
  if (detailsFor) {
    const upd = withNewDetails(state.pending, detailsFor, String(opts.incomingMessage ?? ""));
    if (upd) {
      pendingNow = upd.pending;
      (trace as any).teamItemUpdated = upd.added;
      if (lane === "live") void recordUnansweredQuestion({ tenantId: opts.tenantId, question: `${upd.text} (update: the customer gave ${upd.added.join(", ")})`.slice(0, 300), reason: "no_knowledge", askerKey: opts.conversationId });
    }
  }
  const teamPromise = newTeamQuestion
    ? [{ kind: "promise" as const, text: `${TEAM_PROMISE_PREFIX}${newTeamQuestion.slice(0, 200)}`, at: now }]
    : [];
  if (newTeamQuestion && lane === "live") {
    void recordUnansweredQuestion({ tenantId: opts.tenantId, question: newTeamQuestion, reason: "no_knowledge", askerKey: opts.conversationId });
  }

  // ── Save ──
  const next = mergeState({ ...state, pending: pendingNow }, final.stateUpdate, {
    offered,
    activeSkill: turnTools.openedSkill ?? undefined,
    approvals: [...turnTools.approvals.map((a) => ({ kind: "approval" as const, text: `waiting for approval: ${a.tool}`, tool: a.tool, at: now })), ...teamPromise],
    engineFacts: { ...(cannedNow ? { [CANNED_SENT_FACT]: now } : {}), ...(safetyConversation && !state.facts?.[SAFETY_FACT] ? { [SAFETY_FACT]: now } : {}), ...(searchFailedNow ? { [SEARCH_FAIL_FACT]: now } : state.facts?.[SEARCH_FAIL_FACT] ? { [SEARCH_FAIL_FACT]: "" } : {}), ...inactiveOrdersFact(state.facts?.[INACTIVE_ORDERS_FACT], inactiveOrdersIn(turnTools.records)) },
  });
  await saveState(opts.tenantId, opts.conversationId, lane, config.id, next);
  mark("save");
  trace.tools = turnTools.records;

  const toolCallLog = turnTools.records.map((r) => ({
    tool: r.tool,
    args: r.args,
    result: r.content,
    decision: r.decision === "allow" ? "executed" : r.decision === "approval" ? "awaiting_approval" : r.decision,
    sideEffect: r.decision === "approval" ? "awaiting_approval" : r.decision === "deny" ? "denied" : r.decision === "simulated" ? "simulated" : undefined,
  }));

  if (lane === "live") {
    prisma.auditLog.create({
      data: {
        tenantId: opts.tenantId,
        actorType: "ai",
        action: "ai.bot_turn",
        targetType: "conversation",
        targetId: opts.conversationId,
        metadata: {
          engine: "v2", promptVersion: ENGINE_PROMPT_VERSION, aiAgentId: config.id, model, stageMs, rounds: trace.rounds,
          tokens: trace.tokens,
          toolCalls: turnTools.records.map((r) => ({ tool: r.tool, decision: r.decision === "allow" ? "executed" : r.decision, outcome: r.outcome, ms: r.ms, resultCount: r.resultCount, retried: r.retried || undefined })),
          gate3: trace.gate3, teamQuestion: final.teamQuestion ?? undefined,
          escalation, toolsOffered: trace.toolsOffered, state: { stage: next.stage, intent: next.intent },
        } as any,
      },
    }).catch(() => {});
  }

  // Rolling summary of what slid out of the window, after the reply (off the critical path).
  if (chat.length > cfg.windowMessages && !signal?.aborted) {
    const older = chat.slice(0, chat.length - cfg.windowMessages).filter((m: any) => m.role !== "system");
    void refreshSummary(opts.tenantId, opts.conversationId, config.id, lane, state.summary, older, model).catch(() => {});
  }

  const structuredMessages = lane === "live" && productTurn?.staged?.length ? productTurn.staged : undefined;
  return {
    reply: reply || null,
    interimMessages: [],
    escalation,
    awaitingApproval,
    toolCallLog: toolCallLog as any,
    modelUsed: model,
    totalTokens,
    structuredMessages,
    toolsOffered: surface.names,
    trace,
  } as any;
}

async function refreshSummary(tenantId: string, conversationId: string, aiAgentId: string, lane: StateLane, prev: string | null, older: any[], model: string): Promise<void> {
  const transcript = older.slice(-40).map((m) => `${m.role === "user" ? "Customer" : "Us"}: ${String(m.content).slice(0, 400)}`).join("\n");
  const r = await generateResponse({
    tenantId,
    model,
    messages: [
      { role: "system", content: "Summarise this earlier part of a customer chat in at most 8 short lines: what the customer wants, facts they gave (sizes, budget, order numbers, names), products discussed with prices, and anything promised or still open. No commentary." },
      { role: "user", content: `${prev ? `Earlier summary:\n${prev}\n\n` : ""}Messages:\n${transcript}` },
    ],
    reasoningEffort: "minimal" as any,
    maxTokens: 400,
    metadata: { type: "conversation_summary", conversationId, aiAgentId } as any,
  });
  if (r.content?.trim()) await saveSummary(conversationId, lane, r.content.trim(), new Date());
}
