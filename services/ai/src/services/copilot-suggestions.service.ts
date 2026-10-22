/**
 * Copilot suggestions are GENERATED ON A CUSTOMER MESSAGE and READ from a store.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * `GET /api/ai-assist/:conversationId/suggestions` used to run the model on
 * every request. Opening a conversation - in the old app or v2, by anyone, any
 * number of times - was a model call, a `usage_logs` row and metered AI units,
 * for suggestions about a transcript that had not changed. `runDeduped` only
 * collapsed CONCURRENT requests; three opens a minute apart were three calls.
 *
 * Now the only things that spend tokens are:
 *   1. a customer message arriving in a conversation a PERSON answers
 *      (debounced: a burst of messages is one generation, at the end), and
 *   2. an agent pressing "Try again" (POST .../suggestions/refresh, limited).
 * Opening a conversation reads what is stored. Nothing else.
 *
 * ── Storage is Redis, deliberately ──
 *
 * Suggestions are derived, short-lived coaching, regenerated on the next
 * customer message anyway. A table would be a migration for data with a
 * natural lifetime of minutes. If the entry is evicted, the read says so
 * (`stale: true`, empty) and the agent can press "Try again" - the read never
 * falls back to generating, because that fallback IS the defect being fixed.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { prisma, getRedis, isEntitled, resolveConversationLocale } from "@chatcenter/shared";
import { getEffectiveCopilotConfig, getSuggestions, type ConversationContext } from "./ai-assist.service";
import { publishConvEvent } from "./intelligence/events";
import { beginTurn, isAbortError } from "./turn-cancellation.service";

/** Quiet time after the last customer message before generating. */
export const SUGGESTION_DEBOUNCE_MS = Number(process.env.COPILOT_SUGGESTION_DEBOUNCE_MS || 4_000);
/** How long a stored set lives. It is replaced on the next customer message. */
const STORE_TTL_SECONDS = 14 * 24 * 3600;

export const SUGGESTIONS_UPDATED_EVENT = "copilot.suggestions.updated";

/**
 * A wide dash (em/en/bar) in a suggestion becomes a plain hyphen before it is
 * stored: the agent sends these to customers, and the wide dash is the
 * clearest written-by-AI tell (Omer, 2026-10-06). Only string `text` fields
 * are touched; every other field passes through unchanged.
 */
export function plainDashes<T>(items: T): T {
  if (!Array.isArray(items)) return items;
  return items.map((it: any) =>
    it && typeof it === "object" && typeof it.text === "string"
      ? { ...it, text: it.text.replace(/[\u2013\u2014\u2015]/g, "-") }
      : it,
  ) as unknown as T;
}

export interface StoredSuggestions {
  suggestions: unknown[];
  copilotMode: string;
  /** The last INBOUND message these were built on, or null if there was none. */
  basedOnMessageId: string | null;
  generatedAt: string;
  /** What caused this generation. */
  trigger: "inbound" | "refresh";
}

const storeKey = (tenantId: string, conversationId: string) => `copilot:suggestions:${tenantId}:${conversationId}`;

/** The conversation fields the mode decision reads. */
export interface ModeFields {
  status: string;
  channel: string;
  assignedAgentId: string | null;
  isHandedOver: boolean;
  handledBy: string | null;
  chatbotNodeId: string | null;
}

/**
 * Is a PERSON answering this conversation, so suggestions are worth paying for?
 *
 * Mirrors the incoming worker's own gate for running the bot
 * (incoming.worker.ts: `!assignedAgentId && !isHandedOver`, then
 * `handledBy in (ai_agent, awaiting_approval, flow)` or a parked flow): whatever the
 * bot or a flow is answering gets no suggestions - nobody would read them.
 * Everything else that is open is a person's (assigned, handed over, or waiting
 * in the inbox for pickup).
 *
 * VOICE is excluded because it has its own live pipeline (voice-assist).
 */
export function isCopilotConversation(c: ModeFields): boolean {
  const status = String(c.status);
  if (status === "CLOSED" || status === "RESOLVED") return false;
  if (String(c.channel) === "VOICE") return false;
  if (c.assignedAgentId || c.isHandedOver) return true;
  if (c.handledBy === "ai_agent" || c.handledBy === "awaiting_approval" || c.handledBy === "flow") return false;
  if (c.chatbotNodeId) return false;
  return true;
}

export async function readStoredSuggestions(tenantId: string, conversationId: string): Promise<StoredSuggestions | null> {
  try {
    const raw = await getRedis().get(storeKey(tenantId, conversationId));
    return raw ? (JSON.parse(raw) as StoredSuggestions) : null;
  } catch (err: any) {
    console.warn("[copilot-suggestions] read failed:", err?.message ?? err);
    return null;
  }
}

async function writeStoredSuggestions(tenantId: string, conversationId: string, value: StoredSuggestions): Promise<void> {
  await getRedis().set(storeKey(tenantId, conversationId), JSON.stringify(value), "EX", STORE_TTL_SECONDS);
}

/** The newest customer message, the thing suggestions answer. */
export async function latestInboundId(tenantId: string, conversationId: string): Promise<string | null> {
  const m = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return m?.id ?? null;
}

/** Conversations with a generation scheduled or running in this process. */
const generating = new Set<string>();
export function isGenerating(tenantId: string, conversationId: string): boolean {
  return generating.has(`${tenantId}:${conversationId}`);
}

/**
 * Build the copilot context for one conversation. This is the body the GET
 * handler used to run on every open, moved here unchanged so the inbound
 * trigger and the refresh produce exactly what the panel used to show.
 */
async function buildContext(
  tenantId: string,
  conversationId: string,
  opts: { localeOverride?: string; fallbackUserId?: string; signal?: AbortSignal },
): Promise<{ context: ConversationContext; copilotMode: string } | { notFound: true } | { noConfig: true }> {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) return { notFound: true };

  const messages = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { direction: true, body: true, senderName: true, createdAt: true },
  });

  const copilotConfig = await getEffectiveCopilotConfig(tenantId, (conversation as any).departmentId);
  if (!copilotConfig) return { noConfig: true };

  let departmentName: string | undefined;
  let assignedAgentName: string | undefined;
  try {
    if ((conversation as any).departmentId) {
      const dept = await prisma.department.findUnique({
        where: { id: (conversation as any).departmentId },
        select: { name: true },
      });
      departmentName = dept?.name || undefined;
    }
    if ((conversation as any).assignedAgentId) {
      const agent = await prisma.user.findUnique({
        where: { id: (conversation as any).assignedAgentId },
        select: { name: true, email: true },
      });
      if (agent) assignedAgentName = agent.name?.trim() || agent.email || undefined;
    }
  } catch (err: any) {
    console.warn("[copilot-suggestions] meta lookup failed:", err.message);
  }

  // Suggested replies track the CUSTOMER's language (detectedLocale, else the
  // system effective locale). The fallback user is the assigned agent now that
  // no request is in hand.
  const locale = opts.localeOverride ?? await resolveConversationLocale({
    tenantId,
    conversationId: conversation.id,
    fallbackUserId: opts.fallbackUserId ?? (conversation as any).assignedAgentId ?? undefined,
  }).catch(() => undefined);

  return {
    copilotMode: copilotConfig.copilotMode || "READY_MESSAGE",
    context: {
      tenantId, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.reverse().map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
      locale,
      signal: opts.signal,
      conversationMeta: {
        channel: conversation.channel,
        status: (conversation as any).status,
        departmentName,
        assignedAgentName,
        isHandedOver: (conversation as any).isHandedOver,
        createdAt: conversation.createdAt?.toISOString(),
        lastMessageAt: (conversation as any).lastMessageAt?.toISOString(),
        customerExternalId: conversation.customerExternalId,
        aiAgentId: (conversation as any).assignedAiAgentId || undefined,
      },
    },
  };
}

export type GenerateOutcome =
  | { status: "generated"; stored: StoredSuggestions }
  | { status: "not_found" | "no_config" | "superseded" };

/**
 * Generate, store and announce. The ONLY place a suggestion model call is made
 * for chat. A newer generation for the same conversation aborts this one
 * (beginTurn), so a slow round never overwrites fresher suggestions.
 */
export async function generateAndStore(
  tenantId: string,
  conversationId: string,
  trigger: StoredSuggestions["trigger"],
  opts: { localeOverride?: string; fallbackUserId?: string } = {},
): Promise<GenerateOutcome> {
  const key = `${tenantId}:${conversationId}`;
  const turn = beginTurn(tenantId, conversationId, "copilot");
  generating.add(key);
  try {
    // Read BEFORE the model call: a customer message landing during it is
    // newer than what these suggestions answer, and the read must say stale.
    const basedOnMessageId = await latestInboundId(tenantId, conversationId);
    const built = await buildContext(tenantId, conversationId, { ...opts, signal: turn.signal });
    if ("notFound" in built) return { status: "not_found" };
    if ("noConfig" in built) return { status: "no_config" };

    const suggestions = plainDashes(await getSuggestions(built.context));
    if (turn.signal.aborted) return { status: "superseded" };

    const stored: StoredSuggestions = {
      suggestions,
      copilotMode: built.copilotMode,
      basedOnMessageId,
      generatedAt: new Date().toISOString(),
      trigger,
    };
    await writeStoredSuggestions(tenantId, conversationId, stored);
    // To the conversation's room only (the bridge honours `data.channel`).
    // The screen re-reads the GET; the payload carries no suggestion text so
    // nothing coaching-private rides the bus beyond the stored copy.
    await publishConvEvent({ kind: "conversation", id: conversationId }, SUGGESTIONS_UPDATED_EVENT, {
      tenantId, conversationId, basedOnMessageId, generatedAt: stored.generatedAt,
    });
    console.log(JSON.stringify({
      tag: "copilot.suggestions.generated", tenantId, conversationId, trigger,
      basedOnMessageId, count: Array.isArray(suggestions) ? suggestions.length : 0,
    }));
    return { status: "generated", stored };
  } catch (err) {
    if (isAbortError(err)) return { status: "superseded" };
    throw err;
  } finally {
    turn.end();
    generating.delete(key);
  }
}

const timers = new Map<string, NodeJS.Timeout>();

/**
 * A customer message arrived. Wait for the burst to end, then generate once -
 * if the conversation is a person's and the tenant has Copilot.
 *
 * Eligibility is checked when the timer FIRES, not when the message arrives:
 * a brand-new conversation is routed to an AI employee moments after its first
 * message is published, and that conversation must not pay for suggestions.
 */
export function scheduleSuggestionsOnInbound(tenantId: string, conversationId: string): void {
  const key = `${tenantId}:${conversationId}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  generating.add(key);
  const timer = setTimeout(() => {
    timers.delete(key);
    runIfEligible(tenantId, conversationId)
      .catch((err) => console.warn(`[copilot-suggestions] conv=${conversationId} failed:`, err?.message ?? err))
      .finally(() => { if (!timers.has(key)) generating.delete(key); });
  }, SUGGESTION_DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
  timers.set(key, timer);
}

/** Exported for tests: the decision and the call, without the timer. */
export async function runIfEligible(tenantId: string, conversationId: string): Promise<GenerateOutcome | { status: "skipped"; reason: string }> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { status: true, channel: true, assignedAgentId: true, isHandedOver: true, handledBy: true, chatbotNodeId: true },
  });
  if (!conv) return { status: "skipped", reason: "not_found" };
  if (!isCopilotConversation(conv as unknown as ModeFields)) return { status: "skipped", reason: "ai_or_closed" };
  // The GET is gated on ai.copilot; generating for a tenant without it would
  // spend tokens on suggestions nobody is allowed to read.
  if (!(await isEntitled(tenantId, "ai.copilot"))) return { status: "skipped", reason: "not_entitled" };
  return generateAndStore(tenantId, conversationId, "inbound");
}

/** Test-only. */
export function __resetSuggestionTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  generating.clear();
}
