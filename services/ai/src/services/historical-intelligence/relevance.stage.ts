/**
 * The history import marks each contact personal or business (2026-11-22, Omer: a business can connect a
 * WhatsApp number it also uses personally).
 *
 * Runs after identity and before customer learning. For each imported contact, from that contact's whole
 * imported history:
 *   - a person's existing hand mark on the sender (live or imported) decides, copied as it is;
 *   - else the classifier (the sender rule, the fast rules, then the model) over up to three windows of
 *     12 messages: the earliest, the middle and the latest (one window for 12 or fewer);
 *   - PERSONAL only when every window is personal at PERSONAL_MIN or more. A mixed contact is never
 *     personal: anything else is business.
 * The verdict is written on the contact's imported-history conversation (never in the inbox) as source
 * "import", through the conversation service. A person's mark always wins over it, both ways.
 *
 * What it changes: the sender rule labels a personal contact's NEW conversations personal from their
 * first message (so no automation acts on them), and customer learning, knowledge extraction and the
 * brand voice leave a personal contact's history out.
 *
 * Self-paced like customer learning: a batch of contacts per job. A batch that writes nothing (the
 * conversation service down) ends the stage rather than retrying forever: the import goes on, those
 * contacts unmarked.
 */
import { prisma, getInternalServiceKey } from "@chatcenter/shared";
import { classifyConversation, teamIdentityOf, senderIds, type Relevance, type RelevanceProfile } from "../conversation-relevance.service";
import { getCompanyContext } from "../company-context.service";
import { recordEvent, mapLimited, type StageResult } from "./stage-utils";

export const IMPORT_WINDOW = 12;
/** Every window must be personal at least this sure for the contact to be marked personal. */
export const PERSONAL_MIN = 0.8;
const BATCH_SIZE = 20;
const CONCURRENCY = 3;

type Msg = { direction: string; body: string | null; createdAt: Date; messageType: string | null; metadata?: unknown };
export type ImportVerdict = { category: "personal" | "business"; confidence: number; reason: string };

/** The earliest, the middle and the latest IMPORT_WINDOW messages; one window when there are few. */
export function windowsOf<T>(messages: T[], size = IMPORT_WINDOW): T[][] {
  if (messages.length <= size) return messages.length ? [messages] : [];
  const mid = Math.max(size, Math.min(messages.length - 2 * size, Math.floor((messages.length - size) / 2)));
  const windows = [messages.slice(0, size), messages.slice(mid, mid + size), messages.slice(-size)];
  // A history of 13 to 35 messages: the middle window overlaps the others, which is fine.
  return windows;
}

/** Pure: personal only when every window says personal, sure enough. Never personal from nothing. */
export function importVerdict(labels: Array<Pick<Relevance, "category" | "confidence">>): ImportVerdict {
  const personal = labels.length > 0 && labels.every((l) => l.category === "personal" && Number(l.confidence) >= PERSONAL_MIN);
  if (personal) {
    return { category: "personal", confidence: Math.min(...labels.map((l) => Number(l.confidence))), reason: "import: personal in every part of the history" };
  }
  const mixed = labels.some((l) => l.category === "personal");
  return { category: "business", confidence: mixed ? 0.6 : 0.9, reason: mixed ? "import: mixed history, never personal" : "import: business history" };
}

/** A person's newest hand mark on this sender, on any of their conversations, live or imported. */
async function handMarkOf(tenantId: string, customerExternalId: string, db: any): Promise<"personal" | "business" | null> {
  const ids = senderIds(customerExternalId);
  if (!ids.length) return null;
  const row = await db.conversation.findFirst({
    where: {
      tenantId, channel: "WHATSAPP", customerExternalId: { in: ids }, origin: { in: ["LIVE", "HISTORICAL_IMPORT"] },
      relevanceSource: "override", relevanceOverriddenBy: { not: null },
    },
    orderBy: { relevanceOverriddenAt: "desc" },
    select: { relevanceCategory: true },
  }).catch(() => null);
  return row?.relevanceCategory === "personal" || row?.relevanceCategory === "business" ? row.relevanceCategory : null;
}

/** Through the conversation service (it refuses to replace a person's mark). */
async function writeImportMark(tenantId: string, conversationId: string, v: ImportVerdict, now: Date): Promise<boolean> {
  const base = (process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002").replace(/\/$/, "");
  const res = await fetch(`${base}/internal/conversations/${encodeURIComponent(conversationId)}/relevance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey(), "x-tenant-id": tenantId },
    body: JSON.stringify({ category: v.category, confidence: v.confidence, reason: v.reason, source: "import", classifiedAt: now.toISOString() }),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

export interface RelevanceStageDeps {
  db?: any;
  classify?: typeof classifyConversation;
  write?: typeof writeImportMark;
  profile?: (tenantId: string) => Promise<RelevanceProfile | null>;
  now?: () => Date;
}

export async function runRelevanceStage(args: { tenantId: string; importId: string }, deps: RelevanceStageDeps = {}): Promise<StageResult & { done: boolean; marked?: { personal: number; business: number } }> {
  const { tenantId, importId } = args;
  const db = deps.db ?? prisma;
  const now = deps.now?.() ?? new Date();
  const customers = await db.historicalCustomer.findMany({
    where: { importId, tenantId, conversationId: { not: null }, conversation: { is: { relevanceClassifiedAt: null } } },
    select: { id: true, conversationId: true, externalId: true },
    orderBy: { messageCount: "desc" },
    take: BATCH_SIZE,
  });
  if (customers.length === 0) {
    await recordEvent(importId, "CONTACT_RELEVANCE", "SUCCESS", "every contact marked");
    return { ok: true, done: true };
  }
  const profile = await (deps.profile ?? (async (t: string) => (await getCompanyContext(t).catch(() => null)) as any))(tenantId);
  const users = await db.user.findMany({ where: { tenantId }, select: { email: true, phoneNumber: true }, take: 500 }).catch(() => []);
  const team = teamIdentityOf(users);
  const marked = { personal: 0, business: 0 };
  let written = 0;

  await mapLimited(customers, CONCURRENCY, async (c: any) => {
    try {
      const hand = await handMarkOf(tenantId, c.externalId, db);
      let verdict: ImportVerdict;
      if (hand) {
        verdict = { category: hand, confidence: 1, reason: "import: a person's mark on this sender" };
      } else {
        const messages: Msg[] = await db.message.findMany({
          where: { tenantId, conversationId: c.conversationId },
          orderBy: { createdAt: "asc" },
          select: { direction: true, body: true, createdAt: true, messageType: true, metadata: true },
        });
        const labels: Relevance[] = [];
        for (const w of windowsOf(messages)) {
          labels.push(await (deps.classify ?? classifyConversation)(tenantId, profile, {
            channel: "WHATSAPP", customerExternalId: c.externalId, conversationId: c.conversationId,
            firstDirection: (messages[0]?.direction as any) ?? null, messages: w as any, team,
          }, { db }));
          // One window that is not personal settles it: the contact is business, no more calls.
          if (labels[labels.length - 1]!.category !== "personal") break;
        }
        verdict = importVerdict(labels);
      }
      if (await (deps.write ?? writeImportMark)(tenantId, c.conversationId, verdict, now)) {
        written++;
        marked[verdict.category]++;
      }
    } catch (err) {
      console.warn(`[historical-intelligence] contact relevance failed import=${importId} customer=${c.id}:`, (err as Error)?.message);
    }
  });

  if (written === 0) {
    await recordEvent(importId, "CONTACT_RELEVANCE", "FAILED", "no contact could be marked; the import goes on without the marks");
    return { ok: false, done: true, marked };
  }
  await recordEvent(importId, "CONTACT_RELEVANCE", "SUCCESS", `marked personal=${marked.personal} business=${marked.business}`);
  return { ok: true, done: false, marked };
}
