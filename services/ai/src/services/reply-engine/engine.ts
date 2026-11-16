/**
 * Reply engine v2: one turn, end to end. See contract.ts and
 * docs/architecture/reply-engine-v2.md.
 */
import { prisma, recordUnansweredQuestion } from "@chatcenter/shared";
import { generateResponse, platformPaidScope } from "../ai.service";
import { resolveAgentModel } from "../../lib/agent-model";
import { loadRecentHistory, historyChatMessages, earlierNote } from "../conversation-history.service";
import { getCompanyContext } from "../company-context.service";
import { prepareShopifyTurn } from "../shopify-chat-turn.service";
import { prepareWebchatCommerceTurn, webchatStorefrontBlock, WOO_COMPLEMENTARY_TOOL, wooComplementaryProducts, claimCrossSell, releaseCrossSell } from "../woo-chat-turn.service";
import { computeCalendarCapability } from "../calendar-capability.service";
import { makeScheduleMeetingHandler, makeCheckAvailabilityHandler, makeRescheduleMeetingHandler, makeCancelMeetingHandler, resolveActiveBooking } from "../schedule-handler.service";
import { executeCustomApiTool } from "../connectors/custom-api.service";
import { executeAdapterTool } from "../connectors/integration-framework";
import { enrichProductSearchArgs, isComplementaryTool, complementaryAnchorAllowed } from "../discovery-integration.service";
import { resolveProductRef } from "../product-search.service";
import { retrieveRelevantChunks, buildKnowledgeContext, shouldRecordKnowledgeGap } from "../knowledge.service";
import { humanizeReply } from "../reply-style";
import { takeShowLine, ungroundedPrices, stripPrices } from "../reply-style-check.service";
import { skillApprovalReason } from "../skill-runtime.service";
import { getCrmAdapter } from "../connectors/crm-adapter-resolver";
import { invalidateCrmPrefetch } from "../crm-prefetch.service";
import { assertOrderTargetMatchesTurn, isOrderStateChangingTool } from "../order-reference.service";
import type { AIBotReplyResult } from "../ai-bot.service";
import type { Claim, EngineTurnTrace, ModelTurnOutput, OfferedItem, ReplyEngineMode, StateLane } from "./contract";
import { engineConfig } from "./flags";
import { loadState, mergeState, saveState, saveSummary, renderState, isTeamPromise, TEAM_OPEN_MS, CANNED_SENT_FACT } from "./state";
import { loadEngineSkills, splitInline } from "./skills";
import { buildSurface } from "./surface";
import { buildStablePrefix, buildTurnPart, ENGINE_PROMPT_VERSION } from "./prompt";
import { gate1, gate3, correctionNote, safeFallback, groundedProductFallback, needlessHandoff, cleanStyle, factualProblems, isCannedTeamLine, tooThin } from "./gates";
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
    timed("knowledge", retrieveRelevantChunks(opts.tenantId, String(opts.incomingMessage ?? "").slice(0, 500), 5, config.id, {
      record: lane === "live" && shouldRecordKnowledgeGap({ sandbox: !!opts.sandbox?.enabled, customerExternalId: conversation.customerExternalId, message: opts.incomingMessage }),
      askerKey: opts.conversationId,
    }).catch(() => [] as any[])),
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

  const [state, history, contactRow, company, shopifyTurn, calendar, pendingApprovals, connectedStores, knowledgeChunks, wooRaw] = await loadAll;
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
        if (!id && /^woocommerce\./.test(toolFunctionName) && !/^PRODUCT_\d+$/i.test(String(rawArgs.product_id))) {
          const found: any = await executeAdapterTool({
            tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: contactRow?.id,
            toolFunctionName: "woocommerce.list_products", args: { query: String(rawArgs.product_id).slice(0, 80), per_page: 5, lang: locale }, accessScope: "customer",
          }).catch(() => null);
          const list: any[] = found?.ok && Array.isArray(found.result) ? found.result : [];
          const want = normTitle(rawArgs.product_id);
          const hit = list.find((p) => normTitle(p?.name) === want) ?? (list.length === 1 ? list[0] : null);
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
      return executeAdapterTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        contactId: contactRow?.id,
        toolFunctionName,
        args: effective,
        accessScope: "customer",
      });
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
    company,
    locale,
    skills,
    channel: String(conversation.channel),
    cardsChannel: cardChannel,
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
  const knowledge = buildKnowledgeContext(knowledgeChunks as any, { dropWhenAllWeak: true }) || null;
  const customerName = String((conversation as any).customerName ?? "").trim();
  const customerLine = customerName ? `Name: ${customerName.slice(0, 60)}` : null;
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

  for (let round = 0; round < cfg.maxRounds && !output; round++) {
    const lastRound = round === cfg.maxRounds - 1;
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
      await runToolRound(env, work);
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
      respondCallId = respond.id;
      if (!output) messages.push({ role: "tool", tool_call_id: respond.id, content: "respond needs a reply string; call it again." });
    }
  }
  mark("model");

  // ── Gate 3 ──
  const candidates = turnTools.envelope?.candidates ?? [];
  const grounding = [
    ...turnTools.records.map((r) => r.content),
    JSON.stringify(candidates.map((c: any) => ({ title: c.title, price: c.price, currency: c.currency }))),
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
  const g3Input = (o: ModelTurnOutput) => ({
    reply: resolveKeysInText(o.reply, candidates),
    claims: o.claims,
    cards: o.cards ?? [],
    candidateCount: candidates.length,
    tools: turnTools.records,
    grounding,
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
  });

  let escalation: AIBotReplyResult["escalation"] = turnTools.escalation as any;
  let verdict = output ? gate3(g3Input(output)) : { ok: false, problems: [{ kind: "style" as const, codes: ["empty"] }] };
  // The canned team line goes out at most once per conversation (prod replay 2:
  // it replaced real answers turn after turn). Ours in the history, or the state's mark.
  const cannedSent = !!state.facts?.[CANNED_SENT_FACT] || history.some((m: any) => m.direction === "OUTBOUND" && isCannedTeamLine(m.body));
  let cannedNow = false;
  if (!verdict.ok) {
    // ONE targeted rewrite.
    if (respondCallId) messages.push({ role: "tool", tool_call_id: respondCallId, content: correctionNote(verdict.problems, locale) });
    else messages.push({ role: "system", content: correctionNote(verdict.problems, locale) });
    const first = verdict;
    const original = output;
    let second: ModelTurnOutput | null = null;
    try {
      const forceRespond = { type: "function", function: { name: "respond" } };
      // An unread product, order or policy gets ONE tool round to read it before the rewrite.
      const mayRead = first.problems.some((p) => p.kind === "unread_product" || p.kind === "unread_order" || p.kind === "unread_knowledge" || p.kind === "gave_up_search" || p.kind === "ungrounded_absence");
      let r = await call(mayRead ? "required" : forceRespond);
      if (mayRead) {
        let calls: ModelToolCall[] = (r.toolCalls ?? []) as any;
        // It answered again without reading: the read is the point of this round, so it is asked once more.
        if (!calls.some((c) => c.function?.name !== "respond") && calls.length) {
          messages.push({ role: "assistant", content: r.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
          for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: "Not sent: call the lookup tool first (product, order or knowledge; a narrower search after a timeout), then respond from what it returns." });
          r = await call("required");
          calls = (r.toolCalls ?? []) as any;
        }
        const work = calls.filter((c) => c.function?.name !== "respond");
        if (work.length) {
          messages.push({ role: "assistant", content: r.content || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
          await runToolRound(env, work);
          for (const c of calls) {
            const rec = turnTools.records.find((x) => x.callId === c.id);
            messages.push({ role: "tool", tool_call_id: c.id, content: rec?.content ?? "Not sent: read the results first." });
          }
          r = await call(forceRespond);
        }
      }
      const rc = (r.toolCalls ?? []).find((c: any) => c.function?.name === "respond");
      second = rc ? parseRespond(rc.function.arguments) : null;
    } catch (err: any) {
      if ((err as any)?.name === "AbortError") throw err;
      second = null;
    }
    const v2 = second ? gate3(g3Input(second)) : null;
    if (second && v2?.ok) {
      output = second; verdict = v2; trace.gate3 = { ...first, rewrite: "rewritten" };
    } else {
      // Not clean: what is left is cleaned and sent unless it is a FACT problem
      // (a price, a product or an action no tool backs). The rewrite first, else the original.
      const salvage = (o: ModelTurnOutput | null) => {
        if (!o) return null;
        const v = gate3(g3Input(o));
        const codes = v.problems.flatMap((p) => (p.kind === "style" ? p.codes : []));
        const handoff = v.problems.some((p) => p.kind === "needless_handoff") ? null : o.handoff;
        const cleaned: ModelTurnOutput = { ...o, reply: cleanStyle(o.reply, codes), handoff };
        // Nothing, or too little, left to answer a question with: the other candidate, else the fallback.
        if (!cleaned.reply || tooThin(cleaned.reply, o.reply, opts.incomingMessage ?? "", { cards: cleaned.cards ?? [], titles: candidates.map((c: any) => c?.title).filter(Boolean) })) return null;
        const after = gate3(g3Input(cleaned));
        return factualProblems(after.problems).length ? null : { o: cleaned, v: after };
      };
      const kept = salvage(second) ?? salvage(original);
      if (kept) {
        output = kept.o; verdict = kept.v; trace.gate3 = { ...first, rewrite: "cleaned" };
      } else {
        verdict = v2 ?? first;
        trace.gate3 = { ...first, rewrite: "fallback" };
        // A product turn is answered from what the tools returned, never handed to a person.
        const grounded = groundedProductFallback(candidates as any, locale, cardChannel);
        const question = String(opts.incomingMessage ?? "").slice(0, 300) || null;
        if (grounded) {
          output = { reply: grounded, stateUpdate: {}, claims: [], handoff: null, cards: candidates.map((c: any, i: number) => ({ c, i })).filter((x: any) => x.c?.title && x.c.inventoryState !== "out_of_stock").slice(0, 3).map((x: any) => `PRODUCT_${x.i + 1}`) };
        } else if (!needlessHandoff("reply_failed_checks", inbound, approvalPending)) {
          // The customer's words call for a person (asked for one, damage, a late order).
          output = { reply: cannedSent ? "" : safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };
          cannedNow = !cannedSent;
        } else if (!cannedSent) {
          // Nothing calls for a person: a question for the team, and the AI keeps the chat.
          output = { reply: safeFallback(locale, teamAlreadyOpen), stateUpdate: {}, claims: [], handoff: null, teamQuestion: teamAlreadyOpen ? null : question, cards: [] };
          cannedNow = true;
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
  // Last line of defence (prod replay 4): a price nothing grounds is never sent,
  // whatever path produced the reply. The sentence keeps the rest.
  if (output?.reply) {
    const leftover = ungroundedPrices(resolveKeysInText(output.reply, candidates), grounding);
    if (leftover.length) {
      output = { ...output, reply: stripPrices(resolveKeysInText(output.reply, candidates), leftover).trim() };
      (trace as any).priceStripped = leftover.length;
    }
  }
  const final: ModelTurnOutput = output ?? { reply: cannedSent ? "" : safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };

  // ── Send shape ──
  // A semicolon reads as a document; legacy banned it (eval I05). Fixed, not rewritten.
  const reply = stripLaterOpener(
    (humanizeReply(resolveKeysInText(final.reply, candidates)) ?? "").replace(/\s*;\s*/g, ", "),
    history.some((m: any) => m.direction === "OUTBOUND"),
  );
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
  trace.teamQuestionRepeat = !!final.teamQuestion && !newTeamQuestion;
  const teamPromise = newTeamQuestion
    ? [{ kind: "promise" as const, text: `${TEAM_PROMISE_PREFIX}${newTeamQuestion.slice(0, 200)}`, at: now }]
    : [];
  if (newTeamQuestion && lane === "live") {
    void recordUnansweredQuestion({ tenantId: opts.tenantId, question: newTeamQuestion, reason: "no_knowledge", askerKey: opts.conversationId });
  }

  // ── Save ──
  const next = mergeState(state, final.stateUpdate, {
    offered,
    activeSkill: turnTools.openedSkill ?? undefined,
    approvals: [...turnTools.approvals.map((a) => ({ kind: "approval" as const, text: `waiting for approval: ${a.tool}`, tool: a.tool, at: now })), ...teamPromise],
    engineFacts: cannedNow ? { [CANNED_SENT_FACT]: now } : undefined,
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
