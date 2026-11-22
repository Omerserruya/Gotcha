/**
 * The relevance label BEFORE anything acts (2026-11-22, Omer: a business number that is also used personally).
 *
 * On a conversation's first inbound (and on an unlabelled old one's next inbound) the label is made now, by
 * the ai service (POST /api/internal/relevance/classify: the override first, the account filter, the sender
 * rule, the fast rules, then one model call), and the worker waits for it at most INLINE_WAIT_MS. Then the
 * inbound path asks one question, `hidden`, before each automation, push and responder
 * (packages/shared relevance-hidden.ts).
 *
 * No call when the conversation already has a label or a person's mark (the stored one decides), when the
 * tenant is not in RELEVANCE_CLASSIFY_TENANTS, on a site, store or voice chat, on an account whose filter
 * is off, or in a sandbox rehearsal. A timeout or an error: not hidden, the path runs as before, and the
 * 2-minute job labels it.
 *
 * The 2-minute job is enqueued on every inbound as before; after a model label made here it is told to
 * refine it once.
 */
import * as shared from "@chatcenter/shared";
import { relevanceChannel } from "@chatcenter/shared/src/lib/conversation-relevance";
import { relevanceHidden } from "@chatcenter/shared/src/lib/relevance-hidden";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
/** The longest a customer's message waits for its label. */
export const INLINE_WAIT_MS = 3000;

export interface InlineRelevance {
  hidden: boolean;
  /** What happened, for the one log line and the tests. */
  outcome: "stored" | "labelled" | "no_label" | "timeout" | "error" | "not_classified";
  category: string | null;
  ms: number;
}

type ConversationLike = {
  id: string;
  channel?: string | null;
  channelAccountId?: string | null;
  customerExternalId?: string | null;
  relevanceCategory?: string | null;
  relevanceConfidence?: number | null;
  relevanceOverriddenBy?: string | null;
};

export interface InlineDeps {
  fetch?: typeof fetch;
  enqueue?: typeof shared.enqueueRelevanceClassification;
  db?: any;
  waitMs?: number;
}

async function accountFilterOn(tenantId: string, channelAccountId: string | null | undefined, db: any): Promise<boolean> {
  if (!channelAccountId) return true;
  const acct = await Promise.resolve(db.channelAccount?.findFirst?.({ where: { id: channelAccountId, tenantId }, select: { relevanceFilterEnabled: true } })).catch(() => null);
  return !(acct && acct.relevanceFilterEnabled === false);
}

/** Never throws. */
export async function relevanceBeforeDispatch(tenantId: string, conversation: ConversationLike, deps: InlineDeps = {}): Promise<InlineRelevance> {
  const started = Date.now();
  const done = (r: Omit<InlineRelevance, "ms">): InlineRelevance => ({ ...r, ms: Date.now() - started });
  try {
    // Read from the shared index inside the try: a failure here is "not hidden", never a lost message.
    const db = deps.db ?? shared.prisma;
    if (String(conversation.customerExternalId ?? "").startsWith("sandbox:")) return done({ hidden: false, outcome: "not_classified", category: null });
    // A person's mark decides on every channel and tenant, with no read: the filter does not apply to it.
    if (conversation.relevanceOverriddenBy) {
      return done({ hidden: relevanceHidden(conversation, true), outcome: "stored", category: conversation.relevanceCategory ?? null });
    }
    const eligible = relevanceChannel(conversation.channel) && shared.relevanceClassifyEnabled(tenantId);
    // Nothing stored and nothing to classify (a site chat, a tenant the classifier does not cover): one read less.
    if (!conversation.relevanceCategory && !eligible) return done({ hidden: false, outcome: "not_classified", category: null });

    const filterOn = await accountFilterOn(tenantId, conversation.channelAccountId, db);
    const classifies = eligible && filterOn;
    let result: Omit<InlineRelevance, "ms"> & { source?: string | null };
    if (conversation.relevanceCategory) {
      result = { hidden: relevanceHidden(conversation, filterOn), outcome: "stored", category: conversation.relevanceCategory };
    } else if (classifies) {
      result = await classifyNow(tenantId, conversation.id, filterOn, deps);
    } else {
      result = { hidden: false, outcome: "not_classified", category: null };
    }
    if (classifies) {
      // The 2-minute job, as on every inbound since 2026-11-17 (debounced per conversation). After a model
      // label made here it refines it once.
      const refine = result.outcome === "labelled" && result.source === "model";
      void Promise.resolve((deps.enqueue ?? shared.enqueueRelevanceClassification)(tenantId, conversation.id, undefined, { refine })).catch(() => undefined);
    }
    const { source: _source, ...clean } = result;
    return done(clean);
  } catch (err) {
    console.warn("[relevance] inline label failed, the message goes on as before:", (err as Error)?.message);
    return done({ hidden: false, outcome: "error", category: null });
  }
}

async function classifyNow(tenantId: string, conversationId: string, filterOn: boolean, deps: InlineDeps): Promise<Omit<InlineRelevance, "ms"> & { source?: string | null }> {
  const started = Date.now();
  try {
    const res = await (deps.fetch ?? fetch)(`${AI_SERVICE_URL.replace(/\/$/, "")}/api/internal/relevance/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": shared.getInternalServiceKey() },
      body: JSON.stringify({ tenantId, conversationId }),
      signal: AbortSignal.timeout(deps.waitMs ?? INLINE_WAIT_MS),
    });
    if (!res.ok) throw new Error(`classify ${res.status}`);
    const body: any = await res.json();
    const d = body?.data ?? {};
    const ms = Date.now() - started;
    if (!d.category || d.source === "error") {
      console.log(`[relevance] inline conv=${conversationId} outcome=no_label source=${d.source ?? "-"} ms=${ms}`);
      return { hidden: false, outcome: "no_label", category: null, source: d.source ?? null };
    }
    const confidence = typeof d.confidence === "number" ? d.confidence : null;
    // An override answers as source "override" (it was read, not made): it counts as a person's mark.
    const hidden = relevanceHidden({ relevanceCategory: d.category, relevanceConfidence: confidence, relevanceOverriddenBy: d.source === "override" ? "person" : null }, filterOn);
    console.log(`[relevance] inline conv=${conversationId} outcome=labelled source=${d.source} category=${d.category} hidden=${hidden} ms=${ms}`);
    return { hidden, outcome: "labelled", category: d.category, source: d.source ?? null };
  } catch (err) {
    const ms = Date.now() - started;
    const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
    console.log(`[relevance] inline conv=${conversationId} outcome=${timeout ? "timeout" : "error"} ms=${ms}${timeout ? "" : ` error=${(err as Error)?.message}`}`);
    return { hidden: false, outcome: timeout ? "timeout" : "error", category: null };
  }
}
