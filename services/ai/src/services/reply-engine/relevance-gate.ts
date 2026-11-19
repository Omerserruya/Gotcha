/**
 * Relevance in the reply engine's Gate 1 (2026-11-17, docs/architecture/conversation-relevance.md).
 * NEEDS the a6459560 columns: it reads conversation.relevance_*.
 *
 * RELEVANCE_GATE=off (default): nothing runs, no model call, no cost.
 * RELEVANCE_GATE=shadow: label and record in the trace, write the label, never hold a reply back.
 * RELEVANCE_GATE=on: a person's override, or a label at confidence >= 0.7, holds the AI back for
 *   personal, notice, marketing, auto_reply and internal (no reply, no handoff), and for
 *   reply_to_outbound (a person started it). business and unclear answer as today; so does any error.
 */
import { prisma, getInternalServiceKey } from "@chatcenter/shared";
import { relevanceChannel } from "@chatcenter/shared/src/lib/conversation-relevance";
import { classifyConversation, shouldReclassify, SILENCING, teamIdentityOf, type Relevance, type RelevanceCategory, type RelevanceProfile } from "../conversation-relevance.service";

export type RelevanceGateMode = "off" | "shadow" | "on";
export function relevanceGateMode(env = process.env): RelevanceGateMode {
  const v = String(env.RELEVANCE_GATE ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow" ? v : "off";
}

export const GATE_CONFIDENCE = 0.7;

/** The channel account's relevance filter (default on; a missing account or a failed read counts as on). */
export async function filterOn(tenantId: string, channelAccountId: string | null | undefined, db: any = prisma): Promise<boolean> {
  if (!channelAccountId) return true;
  const a = await db.channelAccount?.findFirst?.({ where: { id: channelAccountId, tenantId }, select: { relevanceFilterEnabled: true } }).catch(() => null);
  return !(a && a.relevanceFilterEnabled === false);
}
const HOLDS: ReadonlySet<RelevanceCategory> = new Set<RelevanceCategory>([...SILENCING, "reply_to_outbound"]);

export interface StoredRelevance {
  category: string | null;
  confidence: number | null;
  classifiedAt: string | null;
  overriddenBy: string | null;
}
export function storedRelevance(conversation: any): StoredRelevance {
  return {
    category: conversation?.relevanceCategory ?? null,
    confidence: typeof conversation?.relevanceConfidence === "number" ? conversation.relevanceConfidence : null,
    classifiedAt: conversation?.relevanceClassifiedAt ? new Date(conversation.relevanceClassifiedAt).toISOString() : null,
    overriddenBy: conversation?.relevanceOverriddenBy ?? null,
  };
}

/** Does this label hold the AI back? A person's override always counts; a classifier label from 0.7. */
export function holdsBack(category: string | null, confidence: number | null, overridden: boolean): boolean {
  if (!category || !HOLDS.has(category as RelevanceCategory)) return false;
  return overridden || Number(confidence ?? 0) >= GATE_CONFIDENCE;
}

export interface RelevanceGateResult {
  mode: RelevanceGateMode;
  category: string | null;
  confidence: number | null;
  source: "override" | "stored" | "fast" | "model" | "sender" | "error" | "filter_off" | null;
  hold: boolean;
}

export interface RelevanceGateDeps {
  classify?: typeof classifyConversation;
  write?: (tenantId: string, conversationId: string, label: Relevance) => Promise<void>;
  db?: any;
  timeoutMs?: number;
  now?: () => Date;
}

/** Through the conversation service's internal write, never the table (it refuses to replace an override). */
export async function writeLabel(tenantId: string, conversationId: string, label: Relevance): Promise<void> {
  const base = (process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002").replace(/\/$/, "");
  const res = await fetch(`${base}/internal/conversations/${encodeURIComponent(conversationId)}/relevance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey(), "x-tenant-id": tenantId },
    body: JSON.stringify({ category: label.category, confidence: label.confidence, reason: label.reason, source: label.source, classifiedAt: label.classifiedAt }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`relevance write ${res.status}`);
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("relevance_timeout")), ms))]);

/**
 * The turn's relevance. The override first, over every rule; then a stored label that is still good;
 * else a fresh label (3s at most), written back in the background. Never throws: an error answers as today.
 */
export async function relevanceForTurn(args: {
  tenantId: string;
  conversation: any;
  history: any[];
  profile: RelevanceProfile | null;
  mode: RelevanceGateMode;
  /** The async job labels this tenant's conversations: a stored label is used as it is (no second call). */
  preferStored?: boolean;
}, deps: RelevanceGateDeps = {}): Promise<RelevanceGateResult> {
  const { tenantId, conversation, history, profile, mode } = args;
  const off: RelevanceGateResult = { mode, category: null, confidence: null, source: null, hold: false };
  if (mode === "off") return off;
  const stored = storedRelevance(conversation);
  if (stored.overriddenBy) {
    return { mode, category: stored.category, confidence: stored.confidence, source: "override", hold: holdsBack(stored.category, stored.confidence, true) };
  }
  // Site and store chats and voice: a visitor is always talking to the business (2026-11-18). No label, no hold.
  if (!relevanceChannel(conversation?.channel)) return { ...off, source: "filter_off" };
  // The business turned the filter off on this channel account (2026-11-18): no label, no hold.
  if (conversation?.channelAccountId && !(await filterOn(tenantId, conversation.channelAccountId, deps.db ?? prisma))) {
    return { ...off, source: "filter_off" };
  }
  const now = deps.now?.() ?? new Date();
  const lastIn = [...(history ?? [])].reverse().find((m: any) => m?.direction === "INBOUND");
  const lastInAt = lastIn?.createdAt ? new Date(lastIn.createdAt) : now;
  if ((args.preferStored && stored.category) || !shouldReclassify(stored, lastInAt, now)) {
    return { mode, category: stored.category, confidence: stored.confidence, source: "stored", hold: holdsBack(stored.category, stored.confidence, false) };
  }
  // This client adds origin LIVE to every conversation read, the sender rule's read of hand marks included: a mark
  // on an imported-history conversation is not seen. Whoever lets the import review write marks must ask for
  // historical rows on purpose in that read.
  const db = deps.db ?? prisma;
  try {
    const label = await withTimeout((async () => {
      const [users, first] = await Promise.all([
        db.user.findMany({ where: { tenantId }, select: { email: true, phoneNumber: true }, take: 500 }).catch(() => []),
        db.message.findFirst({ where: { tenantId, conversationId: conversation.id, NOT: { messageType: "system" } }, orderBy: { createdAt: "asc" }, select: { direction: true } }).catch(() => null),
      ]);
      const messages = (history ?? []).slice(-12).map((m: any) => ({ direction: m.direction, body: m.body, createdAt: m.createdAt, messageType: m.messageType, metadata: m.metadata }));
      const subject = (lastIn?.metadata as any)?.email?.subject ?? null;
      return (deps.classify ?? classifyConversation)(tenantId, profile, {
        channel: String(conversation.channel ?? ""), customerExternalId: conversation.customerExternalId, conversationId: conversation.id,
        firstDirection: first?.direction ?? null, messages, subject, team: teamIdentityOf(users),
      }, { db });
    })(), deps.timeoutMs ?? 3000);
    (deps.write ?? writeLabel)(tenantId, conversation.id, label).catch((err) => console.warn("[relevance] write failed:", (err as Error)?.message));
    return { mode, category: label.category, confidence: label.confidence, source: label.source, hold: holdsBack(label.category, label.confidence, false) };
  } catch (err) {
    console.warn("[relevance] classify failed:", (err as Error)?.message);
    return { ...off, source: "error" };
  }
}
