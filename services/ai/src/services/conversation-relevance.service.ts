/**
 * Conversation relevance (Omer, 2026-11-17): is this conversation the business's own work? Generic by
 * design: no per-tenant keyword lists. It is judged against the business's own profile (what it sells,
 * who its customers are) and the conversation's shape (who wrote first, the channel, the last messages).
 *
 *   business          a customer or lead asking about, ordering or getting service for what the business does
 *   reply_to_outbound a reply to something the business sent first (a supplier, a hotel, an outreach reply)
 *   personal          a private chat (a friend, a partner, family), not about the business
 *   notice            invoices and receipts from vendors, system notices, resets, login alerts, the
 *                     business's OWN purchase shipping notices
 *   marketing         newsletters, promotions, ads, cold sales pitches TO the business
 *   unclear           the model's real uncertainty
 *
 * A cheap deterministic fast path first (bulk headers, no-reply senders, our own notification senders:
 * the reply engine's automatedInbound), then ONE small model call with a short generic rubric and JSON
 * out. Platform-paid ("conversation_classify": the "_classify" usage suffix, outside every tenant budget).
 */
import { automatedInbound } from "./reply-engine/gates";
import { generateResponse, getDefaultModel, platformPaidScope } from "./ai.service";

export type RelevanceCategory = "business" | "reply_to_outbound" | "personal" | "notice" | "marketing" | "unclear";
export const RELEVANCE_CATEGORIES: readonly RelevanceCategory[] = ["business", "reply_to_outbound", "personal", "notice", "marketing", "unclear"];
/** The labels that keep the AI out of a conversation. */
export const SILENCING: ReadonlySet<RelevanceCategory> = new Set<RelevanceCategory>(["personal", "notice", "marketing"]);

export interface Relevance {
  category: RelevanceCategory;
  confidence: number;
  reason: string;
  source: "fast" | "model";
  classifiedAt: string;
}

export interface RelevanceProfile {
  organizationName?: string | null;
  industry?: string | null;
  businessDescription?: string | null;
  websiteDomain?: string | null;
  /** What the business sells, when its AI employee says so (salesContext.whatWeSell). */
  whatWeSell?: string | null;
}

export interface RelevanceMessage {
  direction: "INBOUND" | "OUTBOUND" | string;
  body?: string | null;
  createdAt?: Date | string | null;
  messageType?: string | null;
  metadata?: any;
}

export interface RelevanceInput {
  channel: string;
  customerExternalId?: string | null;
  /** Who wrote first in the whole conversation. */
  firstDirection: "INBOUND" | "OUTBOUND" | null;
  /** The last messages, oldest first. */
  messages: RelevanceMessage[];
  /** An email's subject, when the channel is email. */
  subject?: string | null;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const realMessages = (m: RelevanceMessage[]) => m.filter((x) => x.messageType !== "system" && clip(x.body, 1).length > 0);

/** The fast path: mail no person wrote, decided with no model call. Null when it does not apply. */
export function fastRelevance(c: RelevanceInput, now = new Date()): Relevance | null {
  const lastIn = [...c.messages].reverse().find((m) => m.direction === "INBOUND");
  if (!lastIn) return null;
  const why = automatedInbound({ channel: c.channel, sender: c.customerExternalId, body: lastIn.body, metadata: lastIn.metadata });
  if (!why) return null;
  // A list or a sending subdomain is marketing; a no-reply or system sender, or a notice's footer, is a notice.
  const marketingText = /\b(?:unsubscribe|newsletter|sale|% off|discount|promo|offer|deal|webinar|new features?)\b|(?:להסרה מרשימת|מבצע|הנחה|ניוזלטר)/iu.test(String(lastIn.body ?? ""));
  const category: RelevanceCategory = why === "ingest_list" || why === "bulk_domain" || (why === "bulk_footer" && marketingText) ? "marketing" : "notice";
  return { category, confidence: 0.95, reason: `automated mail (${why})`, source: "fast", classifiedAt: now.toISOString() };
}

const RUBRIC = `You label ONE conversation of a business's inbox. Decide who it is with and what it is about, judged against the business below. Categories:
- business: a customer or a lead asking about, buying, or getting service for what THIS business sells or does.
- reply_to_outbound: the business wrote first and this is the other side answering (a supplier, a hotel, a partner, someone the business reached out to), not a customer of the business.
- personal: a private chat (a friend, a partner, family) that is not about the business.
- notice: an automatic or vendor message to the business: an invoice or receipt, a system notification, a password reset, a login alert, shipping of something the business itself bought.
- marketing: a newsletter, a promotion, an ad, or a cold sales pitch TO the business.
- unclear: you truly cannot tell.
A message that asks about the business's products or services, its orders, prices or opening hours is business, even when it is short or informal. Do not guess from the language or the name alone.
Answer with JSON only: {"category": "...", "confidence": 0.0-1.0, "reason": "at most 15 words"}.`;

/** The model's messages for one conversation: the rubric, the business, and the conversation's shape. */
export function relevancePrompt(profile: RelevanceProfile | null, c: RelevanceInput): Array<{ role: "system" | "user"; content: string }> {
  const biz = profile
    ? [
        `Business: ${clip(profile.organizationName, 80) || "(no name)"}${profile.industry ? ` (${clip(profile.industry, 60)})` : ""}${profile.websiteDomain ? `, ${clip(profile.websiteDomain, 60)}` : ""}.`,
        profile.businessDescription ? `What it does: ${clip(profile.businessDescription, 400)}` : "",
        profile.whatWeSell ? `What it sells: ${clip(profile.whatWeSell, 200)}` : "",
      ].filter(Boolean).join("\n")
    : "Business: (no profile)";
  const lines = realMessages(c.messages).slice(-8).map((m) => `[${m.direction === "OUTBOUND" ? "business" : "contact"}] ${clip(m.body, 300)}`);
  const email = /^(?:EMAIL|GMAIL|OUTLOOK)$/i.test(c.channel) ? `\nEmail from: ${clip(c.customerExternalId, 80)}${c.subject ? `\nSubject: ${clip(c.subject, 120)}` : ""}` : "";
  const user = `${biz}\n\nChannel: ${c.channel}\nWho wrote first: ${c.firstDirection === "OUTBOUND" ? "the business" : c.firstDirection === "INBOUND" ? "the contact" : "unknown"}${email}\n\nLast messages (oldest first):\n${lines.join("\n") || "(none)"}`;
  return [{ role: "system", content: RUBRIC }, { role: "user", content: user }];
}

/** The model's JSON, read defensively: anything unreadable is unclear with no confidence. */
export function parseRelevance(text: string | null | undefined): { category: RelevanceCategory; confidence: number; reason: string } {
  let v: any = null;
  try { v = JSON.parse(String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { v = null; }
  const category = RELEVANCE_CATEGORIES.includes(v?.category) ? (v.category as RelevanceCategory) : "unclear";
  const n = Number(v?.confidence);
  const confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  return { category, confidence: category === "unclear" && !RELEVANCE_CATEGORIES.includes(v?.category) ? 0 : confidence, reason: clip(v?.reason, 120) };
}

export interface ClassifyDeps {
  generate?: typeof generateResponse;
  model?: string;
  now?: () => Date;
}

/** One conversation's relevance: the fast path, else one small platform-paid model call. */
export async function classifyConversation(tenantId: string, profile: RelevanceProfile | null, c: RelevanceInput, deps: ClassifyDeps = {}): Promise<Relevance> {
  const now = deps.now?.() ?? new Date();
  const fast = fastRelevance(c, now);
  if (fast) return fast;
  // No customer message yet: nothing to judge.
  if (!realMessages(c.messages).some((m) => m.direction === "INBOUND")) return { category: "unclear", confidence: 0, reason: "no inbound message", source: "model", classifiedAt: now.toISOString() };
  const gen = deps.generate ?? generateResponse;
  const r = await platformPaidScope.run({ reason: "conversation_classify" }, () => gen({
    tenantId,
    model: deps.model ?? getDefaultModel(),
    messages: relevancePrompt(profile, c),
    responseFormat: { type: "json_object" },
    // Room for a reasoning model's thinking before the short JSON.
    maxTokens: 400,
    reasoningEffort: "minimal",
    metadata: { type: "conversation_relevance" },
  }));
  const parsed = parseRelevance((r as any)?.content ?? (r as any)?.text ?? "");
  return { ...parsed, source: "model", classifiedAt: now.toISOString() };
}

/** Re-run when a new inbound came after the last label AND the label is old or was unsure; never over an override. */
export function shouldReclassify(prev: { classifiedAt?: string | null; confidence?: number | null; overriddenBy?: string | null } | null, lastInboundAt: Date | null, now = new Date(), maxAgeMs = 6 * 60 * 60_000): boolean {
  if (prev?.overriddenBy) return false;
  if (!prev?.classifiedAt) return true;
  const at = Date.parse(prev.classifiedAt);
  if (!lastInboundAt || lastInboundAt.getTime() <= at) return false;
  return now.getTime() - at > maxAgeMs || Number(prev.confidence ?? 0) < 0.7;
}
