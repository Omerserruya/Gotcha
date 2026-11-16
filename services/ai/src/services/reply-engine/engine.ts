/**
 * Reply engine v2: one turn, end to end. See contract.ts and
 * docs/architecture/reply-engine-v2.md.
 */
import { prisma, recordUnansweredQuestion } from "@chatcenter/shared";
import { generateResponse, platformPaidScope } from "../ai.service";
import { resolveAgentModel } from "../../lib/agent-model";
import { loadRecentHistory } from "../conversation-history.service";
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
import { skillApprovalReason } from "../skill-runtime.service";
import { getCrmAdapter } from "../connectors/crm-adapter-resolver";
import { invalidateCrmPrefetch } from "../crm-prefetch.service";
import { assertOrderTargetMatchesTurn, isOrderStateChangingTool } from "../order-reference.service";
import type { AIBotReplyResult } from "../ai-bot.service";
import type { Claim, EngineTurnTrace, ModelTurnOutput, OfferedItem, ReplyEngineMode, StateLane } from "./contract";
import { engineConfig } from "./flags";
import { loadState, mergeState, saveState, saveSummary, renderState } from "./state";
import { loadEngineSkills, splitInline } from "./skills";
import { buildSurface } from "./surface";
import { buildStablePrefix, buildTurnPart, ENGINE_PROMPT_VERSION } from "./prompt";
import { gate1, gate3, correctionNote, safeFallback, groundedProductFallback, needlessHandoff } from "./gates";
import { newTurnTools, runToolRound, type ModelToolCall, type RunnerEnv } from "./tools";

export interface EngineTurnOpts {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  incomingMessage: string;
  closedHours?: { nextOpeningIso: string | null; timezone: string; nextOpeningText?: { en?: string; he?: string } | null };
  sandbox?: { enabled: true; writes: "safe" | "real" };
}

const HEB = /[֐-׿]/;

/** The conversation's language: the customer's own recent words decide. */
export function conversationLocale(inbound: string[]): "he" | "en" {
  const recent = inbound.slice(-4).join(" ");
  return HEB.test(recent) ? "he" : "en";
}

/** Parse the model's `respond` arguments, tolerantly. */
export function parseRespond(raw: string | undefined): ModelTurnOutput | null {
  let v: any;
  try { v = JSON.parse(raw || "{}"); } catch { return null; }
  if (!v || typeof v !== "object" || typeof v.reply !== "string") return null;
  const su = v.state_update && typeof v.state_update === "object" ? v.state_update : {};
  const claims: Claim[] = Array.isArray(v.claims)
    ? v.claims.filter((c: any) => c && typeof c.text === "string").map((c: any) => ({ kind: ["price", "product", "action", "fact"].includes(c.kind) ? c.kind : "fact", text: c.text, source: c.source }))
    : [];
  return {
    reply: v.reply,
    stateUpdate: { stage: su.stage, intent: su.intent, facts: su.facts, pending: Array.isArray(su.pending) ? su.pending : undefined },
    claims,
    handoff: typeof v.handoff === "string" && v.handoff.trim() ? v.handoff.trim() : null,
    teamQuestion: typeof v.team_question === "string" && v.team_question.trim() ? v.team_question.trim().slice(0, 500) : null,
    cards: Array.isArray(v.cards) ? v.cards.filter((k: any) => typeof k === "string") : [],
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

function historyToChat(history: any[]): any[] {
  const out: any[] = [];
  for (const m of history) {
    const body = String(m?.body ?? "").trim();
    if (!body) continue;
    const kind = (m?.metadata as any)?.kind;
    if (kind === "interim_ack" || kind === "holding") continue;
    if (m.direction === "INBOUND") out.push({ role: "user", content: body });
    else if (m.direction === "OUTBOUND") out.push({ role: "assistant", content: body });
  }
  return out;
}

function closedHoursText(c: EngineTurnOpts["closedHours"], locale: "he" | "en"): string | null {
  if (!c) return null;
  const when = (locale === "he" ? c.nextOpeningText?.he : c.nextOpeningText?.en) ?? c.nextOpeningIso ?? "later";
  return `The team is closed now; it opens ${when} (${c.timezone}). You can still help; anything that needs a person waits until then, say so honestly.`;
}

export async function runReplyEngineTurn(opts: EngineTurnOpts, mode: ReplyEngineMode, signal?: AbortSignal): Promise<AIBotReplyResult & { trace: EngineTurnTrace }> {
  const lane: StateLane = mode === "shadow" ? "shadow" : "live";
  if (lane === "shadow") {
    // Shadow is paid by the platform: every call is logged billedTo "platform" and nothing is debited.
    return platformPaidScope.run({ reason: "reply_engine_shadow" }, () => runTurn(opts, mode, lane, signal));
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
  const model = resolveAgentModel(config.model);

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
    timed("history", loadRecentHistory<any>(opts.tenantId, opts.conversationId, 60)),
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
    platformPaid: lane === "shadow",
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
  const locale = conversationLocale(inbound);
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
  if (opts.incomingMessage && (chat.at(-1)?.role !== "user" || chat.at(-1)?.content !== opts.incomingMessage.trim())) {
    chat.push({ role: "user", content: opts.incomingMessage });
  }
  const windowed = chat.slice(-cfg.windowMessages);
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
      metadata: { type: lane === "shadow" ? "ai_bot_shadow" : "ai_bot", conversationId: opts.conversationId, aiAgentId: config.id, engine: "v2" } as any,
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
      if (r.content?.trim()) output = { reply: r.content.trim(), stateUpdate: {}, claims: [], handoff: null, cards: [] };
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
    recentInbound: inbound,
    toolsNeedPerson: approvalPending || turnTools.records.some((r) => r.decision === "deny"),
  });

  let escalation: AIBotReplyResult["escalation"] = turnTools.escalation as any;
  let verdict = output ? gate3(g3Input(output)) : { ok: false, problems: [{ kind: "style" as const, codes: ["empty"] }] };
  if (!verdict.ok) {
    // ONE targeted rewrite.
    if (respondCallId) messages.push({ role: "tool", tool_call_id: respondCallId, content: correctionNote(verdict.problems, locale) });
    else messages.push({ role: "system", content: correctionNote(verdict.problems, locale) });
    const first = verdict;
    try {
      const forceRespond = { type: "function", function: { name: "respond" } };
      // An unread product gets ONE tool round to read it before the rewrite.
      const mayRead = first.problems.some((p) => p.kind === "unread_product");
      let r = await call(mayRead ? "required" : forceRespond);
      if (mayRead) {
        const calls: ModelToolCall[] = (r.toolCalls ?? []) as any;
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
      const second = rc ? parseRespond(rc.function.arguments) : null;
      const v2 = second ? gate3(g3Input(second)) : first;
      if (second && v2.ok) { output = second; verdict = v2; trace.gate3 = { ...first, rewrite: "rewritten" }; }
      else { verdict = v2; output = null; }
    } catch (err: any) {
      if ((err as any)?.name === "AbortError") throw err;
      output = null;
    }
    if (!output) {
      trace.gate3 = { ...first, rewrite: "fallback" };
      // A product turn is answered from what the tools returned, never handed to a person.
      const grounded = groundedProductFallback(candidates as any, locale, cardChannel);
      output = grounded
        ? { reply: grounded, stateUpdate: {}, claims: [], handoff: null, cards: candidates.map((c: any, i: number) => ({ c, i })).filter((x: any) => x.c?.title && x.c.inventoryState !== "out_of_stock").slice(0, 3).map((x: any) => `PRODUCT_${x.i + 1}`) }
        : needlessHandoff("reply_failed_checks", inbound, approvalPending)
          // Nothing calls for a person: a question for the team, and the AI keeps the chat.
          ? { reply: safeFallback(locale), stateUpdate: {}, claims: [], handoff: null, teamQuestion: String(opts.incomingMessage ?? "").slice(0, 300) || null, cards: [] }
          : { reply: safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };
    }
  } else {
    trace.gate3 = { ...verdict, rewrite: "none" };
  }
  mark("gate3");
  const final: ModelTurnOutput = output ?? { reply: safeFallback(locale), stateUpdate: {}, claims: [], handoff: "reply_failed_checks", cards: [] };

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

  // A question for the team: on the owner's unanswered list, and an open promise in the state. No handoff.
  const teamPromise = final.teamQuestion
    ? [{ kind: "promise" as const, text: `checking with the team: ${final.teamQuestion.slice(0, 200)}`, at: now }]
    : [];
  if (final.teamQuestion && lane === "live") {
    void recordUnansweredQuestion({ tenantId: opts.tenantId, question: final.teamQuestion, reason: "no_knowledge", askerKey: opts.conversationId });
  }

  // ── Save ──
  const next = mergeState(state, final.stateUpdate, {
    offered,
    activeSkill: turnTools.openedSkill ?? undefined,
    approvals: [...turnTools.approvals.map((a) => ({ kind: "approval" as const, text: `waiting for approval: ${a.tool}`, tool: a.tool, at: now })), ...teamPromise],
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
    const older = chat.slice(0, chat.length - cfg.windowMessages);
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
