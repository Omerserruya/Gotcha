/**
 * Customer Context aggregator.
 *
 * Loads the "what does the system remember about this person" bundle that
 * the side panel, the bot's prompt construction, and AI tools all need.
 * Pulls from THREE sources in parallel:
 *   1. GOTCHA's own conversation_intelligence table - recent AI summaries +
 *      sentiment/qualification + action_items.
 *   2. GOTCHA's messages table - last N inbound/outbound for keyword search.
 *   3. CRM via the adapter - open tasks (= "open issues") and recent notes
 *      (vendor-side timeline) when the contact is linked.
 *
 * No new state table - every field is derived from data that already exists.
 * Cache-friendly: each input identifier (conversationId / crmContactId)
 * produces a deterministic bundle; callers can wrap with their own cache.
 *
 * All vendor calls are wrapped in try/catch - a failing CRM does NOT block
 * the panel; missing sections just render empty.
 */

import { prisma } from "@chatcenter/shared";
import { getCrmAdapter } from "../connectors/crm-adapter-resolver";
import { getConversationIntelligence } from "../conversation-intelligence.service";
import type {
  CrmActivity,
  CrmObjectKind,
  CrmTask,
} from "../connectors/crm-adapter.types";

export interface RecentSummary {
  conversationId: string;
  channel: string;
  summary: string;
  sentiment: string | null;
  qualification: string | null;
  actionItems: string[];
  occurredAt: string;
  isCurrentConversation: boolean;
}

export interface CustomerContextBundle {
  tenantId: string;
  conversationId: string | null;
  personId: string | null;
  crmContactId: string | null;
  crmObjectKind: CrmObjectKind | null;
  vendor: string | null;
  /** Every conversation found for this customer across channels via the
   *  identity walk (personId + CRM pin + phone + email). Includes the
   *  current conversation if it's in scope. */
  sibling_conversation_ids: string[];
  /** Last N AI summaries across all conversations for this customer. */
  recent_summaries: RecentSummary[];
  /** CRM-side open issues (incomplete tasks). */
  open_issues: CrmTask[];
  /** CRM-side recent notes (vendor timeline). */
  recent_crm_notes: CrmActivity[];
  /** Unified vendor timeline - notes + tasks + calls + emails + meetings. */
  recent_activities: CrmActivity[];
  /** Aggregate sentiment trend (last 5 conversations). */
  sentiment_trend: ("positive" | "neutral" | "negative" | "unknown")[];
  /** Reasons + missing pieces - useful for debugging stale links. */
  meta: {
    summaries_count: number;
    open_issues_count: number;
    crm_notes_count: number;
    activities_count: number;
    siblings_count: number;
    crm_link_reason?: string;
    intel_loaded_ms?: number;
    crm_loaded_ms?: number;
  };
}

interface LoadArgs {
  tenantId: string;
  /** Either pass a conversationId (we resolve everything from it) ... */
  conversationId?: string;
  /** ... or pass a direct CRM contact id + kind. */
  crmContactId?: string;
  crmObjectKind?: CrmObjectKind;
  /** Pull up to N summaries (default 5). */
  summaryLimit?: number;
  /** Pull up to N CRM notes (default 5). */
  crmNoteLimit?: number;
}

/**
 * Resolve a conversation → its (channel, externalId) → matched GOTCHA
 * Contact row → CRM mapping pinned in Contact.metadata.
 *
 * This walks the same chain that crm-panel.ts:loadConversationContext does
 * - duplicated intentionally to keep this module self-contained (memory
 * tools may be called from outside the route handler).
 */
async function resolveFromConversation(tenantId: string, conversationId: string): Promise<{
  channel: string | null;
  externalId: string | null;
  contactId: string | null;
  personId: string | null;
  phone: string | null;
  email: string | null;
  crmContactId: string | null;
  crmObjectKind: CrmObjectKind | null;
}> {
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { channel: true, customerExternalId: true },
  });
  if (!conv) return { channel: null, externalId: null, contactId: null, personId: null, phone: null, email: null, crmContactId: null, crmObjectKind: null };

  const contact = await (prisma as any).contact.findFirst({
    where: { tenantId, channel: conv.channel, externalId: conv.customerExternalId },
    select: { id: true, personId: true, phone: true, email: true, metadata: true },
  });
  const meta = (contact?.metadata ?? {}) as Record<string, any>;
  return {
    channel: conv.channel,
    externalId: conv.customerExternalId,
    contactId: contact?.id ?? null,
    personId: contact?.personId ?? null,
    phone: contact?.phone ?? null,
    email: contact?.email ?? null,
    crmContactId: meta?.crmContactId ?? null,
    crmObjectKind: meta?.crmObjectKind ?? null,
  };
}

/**
 * Find all GOTCHA conversations for the same customer across channels.
 *
 * For cross-channel continuity we walk Contact.personId when present (the
 * GotchaPerson identity), otherwise we look up by the CRM mapping - every
 * GOTCHA Contact pinned to the same crmContactId belongs to the same
 * person. Falls back to same-channel-only when neither identity layer
 * gives us a wider view.
 */
async function findRelatedConversations(args: {
  tenantId: string;
  personId: string | null;
  crmContactId: string | null;
  phone: string | null;
  email: string | null;
  /** Additional sibling externalIds harvested from the CRM record's
   *  gotcha_* channel fields (PSID, WA id, FB page id, etc.). */
  extraExternalIds: string[];
  fallbackChannel: string | null;
  fallbackExternalId: string | null;
  limit: number;
}): Promise<string[]> {
  const { tenantId, personId, crmContactId, phone, email, extraExternalIds, fallbackChannel, fallbackExternalId, limit } = args;

  // Walk Contact rows that represent the same human, then fan out to every
  // conversation those Contact rows ever owned. We union from EVERY available
  // identity layer so a half-linked customer (e.g. personId not set but
  // phone matches across rows) still gets the full cross-channel view.
  //
  // Mirrors the strategy used by conversation.service.ts:getHistoryByCustomerExternalId
  // - keep them aligned so the side panel + AI brief see the same prior history.
  const siblingFilters: Array<{ channel: string; customerExternalId: string }> = [];
  const externalIdSet = new Set<string>();
  const seen = new Set<string>();
  if (fallbackExternalId) externalIdSet.add(fallbackExternalId);

  const collectSiblings = async (where: Record<string, unknown>) => {
    const rows = await (prisma as any).contact.findMany({
      where: { tenantId, ...where },
      select: { channel: true, externalId: true },
    });
    for (const r of rows) {
      const key = `${r.channel}::${r.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      siblingFilters.push({ channel: r.channel, customerExternalId: r.externalId });
      if (r.externalId) externalIdSet.add(r.externalId);
    }
  };

  // 1. GOTCHA-native identity (assigned by the unifier on shared email/phone).
  if (personId) await collectSiblings({ personId });

  // 2. CRM-pinned identity (metadata.crmContactId).
  if (crmContactId) {
    await collectSiblings({ metadata: { path: ["crmContactId"], equals: crmContactId } });
  }

  // 3. Same-phone walk - catches sibling Contact rows on different channels
  //    that haven't been unified yet but share the same phone number. WhatsApp
  //    stores phone digits as externalId so we ALSO add the raw digits to
  //    cover legacy national-format storage.
  if (phone) {
    await collectSiblings({ phone });
    const digits = phone.replace(/\D/g, "");
    externalIdSet.add(phone);
    if (digits) externalIdSet.add(digits);
  }

  // 4. Same-email walk.
  if (email) await collectSiblings({ email: email.toLowerCase() });

  // 5. Channel external IDs harvested from the CRM record itself. Each
  //    gotcha_psid_*, gotcha_wa_id, etc. is the customerExternalId of a
  //    conversation we might own on that channel - even if no local
  //    Contact row exists yet (channel webhook hasn't fired, but the
  //    operator manually populated the CRM field).
  for (const xid of extraExternalIds) {
    if (xid) externalIdSet.add(xid);
  }

  // Conversations matching ANY sibling Contact row OR an externalId we
  // collected (the phone-as-externalId case).
  const conversationOr: any[] = [...siblingFilters];
  if (externalIdSet.size > 0) {
    conversationOr.push({ customerExternalId: { in: Array.from(externalIdSet) } });
  }

  if (conversationOr.length > 0) {
    const convs = await (prisma as any).conversation.findMany({
      where: { tenantId, OR: conversationOr },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    return convs.map((c: any) => c.id);
  }

  // 5. Same-channel-only fallback when nothing else matched.
  if (fallbackChannel && fallbackExternalId) {
    const convs = await (prisma as any).conversation.findMany({
      where: { tenantId, channel: fallbackChannel, customerExternalId: fallbackExternalId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true },
    });
    return convs.map((c: any) => c.id);
  }

  return [];
}

// ─── Main entrypoint ───────────────────────────────────────

export async function loadCustomerContext(args: LoadArgs): Promise<CustomerContextBundle> {
  const summaryLimit = args.summaryLimit ?? 5;
  const crmNoteLimit = args.crmNoteLimit ?? 5;

  // 1. Resolve identity. We always run the resolver when a conversationId is
  //    provided, even if the caller already passed a crmContactId - we still
  //    need personId/phone/email + channel/externalId to build the
  //    cross-channel sibling walk.
  let channel: string | null = null;
  let externalId: string | null = null;
  let personId: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;
  let crmContactId: string | null = args.crmContactId ?? null;
  let crmObjectKind: CrmObjectKind | null = args.crmObjectKind ?? null;

  if (args.conversationId) {
    const resolved = await resolveFromConversation(args.tenantId, args.conversationId);
    channel = resolved.channel;
    externalId = resolved.externalId;
    personId = resolved.personId;
    phone = resolved.phone;
    email = resolved.email;
    crmContactId = crmContactId ?? resolved.crmContactId;
    crmObjectKind = crmObjectKind ?? resolved.crmObjectKind;
  }

  // CRM-side identifier enrichment. The local Contact row is often sparse
  // (the channel webhook only saw the PSID - phone/email live in the CRM
  // record). Pull the canonical phone/email/per-channel external IDs from
  // the CRM via the adapter, so the sibling walk sees them. Mirrors
  // conversation.service.ts:fetchCrmIdentifiersForConversation so the side
  // panel + AI brief use the same expansion strategy.
  const extraExternalIds: string[] = [];
  if (crmContactId && crmObjectKind) {
    try {
      const adapter = await getCrmAdapter(args.tenantId);
      if (!adapter.capabilities.is_stub) {
        const ctxRes = await adapter.getCustomerContext({ contact_id: crmContactId, kind: crmObjectKind });
        if (ctxRes.ok && ctxRes.context) {
          const contact = ctxRes.context.contact;
          phone = phone ?? contact.phone ?? null;
          email = email ?? contact.email ?? null;
          // Every gotcha_* channel identifier on the CRM record is a sibling
          // externalId for that channel (PSID for IG, WA id for WhatsApp, etc.).
          const cf = (contact.custom_fields ?? {}) as Record<string, unknown>;
          for (const [k, v] of Object.entries(cf)) {
            if (!k.startsWith("gotcha_")) continue;
            if (typeof v !== "string" || !v.trim()) continue;
            // Skip the source marker - it's not an externalId.
            if (k === "gotcha_source_interaction_id") continue;
            extraExternalIds.push(v);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[customer-context] CRM identifier enrichment failed: ${err?.message}`);
    }
  }

  // 2. Walk to related conversations across channels via every identity
  //    layer (personId + CRM pin + shared phone + shared email + every
  //    gotcha_* channel external_id stored on the CRM record). Falls
  //    back to same-channel-only when nothing matches.
  const relatedIds = await findRelatedConversations({
    tenantId: args.tenantId,
    personId,
    crmContactId,
    phone,
    email,
    extraExternalIds,
    fallbackChannel: channel,
    fallbackExternalId: externalId,
    limit: Math.max(summaryLimit, 5),
  });

  // 3. Parallel fetch: GOTCHA intelligence + CRM data.
  const intelStart = Date.now();
  const intelPromise = (async (): Promise<RecentSummary[]> => {
    if (relatedIds.length === 0) return [];
    const results: RecentSummary[] = [];
    // Limit batch - bounded N keeps latency predictable.
    for (const convId of relatedIds.slice(0, summaryLimit)) {
      try {
        const intel = await getConversationIntelligence(args.tenantId, convId);
        if (!intel) continue;
        const conv = await (prisma as any).conversation.findFirst({
          where: { id: convId, tenantId: args.tenantId },
          select: { channel: true, createdAt: true },
        });
        results.push({
          conversationId: convId,
          channel: conv?.channel ?? "unknown",
          summary: (intel as any).summary ?? "",
          sentiment: (intel as any).sentiment ?? null,
          qualification: (intel as any).qualification ?? null,
          actionItems: Array.isArray((intel as any).actionItems) ? (intel as any).actionItems : [],
          occurredAt: (conv?.createdAt ?? new Date()).toISOString(),
          isCurrentConversation: convId === args.conversationId,
        });
      } catch {
        // Per-conversation failure is non-fatal.
      }
    }
    return results;
  })();

  const crmStart = Date.now();
  const crmPromise = (async (): Promise<{ tasks: CrmTask[]; notes: CrmActivity[]; activities: CrmActivity[]; vendor: string | null; reason?: string }> => {
    if (!crmContactId || !crmObjectKind) {
      return { tasks: [], notes: [], activities: [], vendor: null, reason: "no_crm_link" };
    }
    try {
      const adapter = await getCrmAdapter(args.tenantId);
      if (adapter.capabilities.is_stub) return { tasks: [], notes: [], activities: [], vendor: adapter.vendor, reason: "no_crm_configured" };

      const [taskResult, noteResult, activityResult] = await Promise.all([
        adapter.listTasks
          ? adapter.listTasks({ contact_id: crmContactId, kind: crmObjectKind, openOnly: true, limit: 10 }).catch(() => ({ ok: false, tasks: [] as CrmTask[] }))
          : Promise.resolve({ ok: true, tasks: [] as CrmTask[] }),
        adapter.listRecentNotes
          ? adapter.listRecentNotes({ contact_id: crmContactId, kind: crmObjectKind, limit: crmNoteLimit }).catch(() => ({ ok: false, activities: [] as CrmActivity[] }))
          : Promise.resolve({ ok: true, activities: [] as CrmActivity[] }),
        adapter.listRecentActivities
          ? adapter.listRecentActivities({ contact_id: crmContactId, kind: crmObjectKind, limit: crmNoteLimit }).catch(() => ({ ok: false, activities: [] as CrmActivity[] }))
          : Promise.resolve({ ok: true, activities: [] as CrmActivity[] }),
      ]);
      return {
        tasks: (taskResult as any).tasks ?? [],
        notes: (noteResult as any).activities ?? [],
        activities: (activityResult as any).activities ?? [],
        vendor: adapter.vendor,
      };
    } catch (err: any) {
      return { tasks: [], notes: [], activities: [], vendor: null, reason: err?.message ?? "crm_load_failed" };
    }
  })();

  const [summaries, crmBundle] = await Promise.all([intelPromise, crmPromise]);
  const intelMs = Date.now() - intelStart;
  const crmMs = Date.now() - crmStart;

  console.log(
    `[customer-context] tenant=${args.tenantId} conv=${args.conversationId ?? "-"} ` +
    `personId=${personId ?? "-"} crm=${crmContactId ?? "-"}:${crmObjectKind ?? "-"} ` +
    `phone=${phone ?? "-"} email=${email ?? "-"} extraXids=${extraExternalIds.length} ` +
    `siblings=${relatedIds.length} summaries=${summaries.length} ` +
    `notes=${crmBundle.notes.length} tasks=${crmBundle.tasks.length} ` +
    `activities=${crmBundle.activities.length} ` +
    `vendor=${crmBundle.vendor ?? "-"} reason=${crmBundle.reason ?? "-"} ` +
    `intelMs=${intelMs} crmMs=${crmMs}`,
  );

  const sentiment_trend = summaries.slice(0, 5).map((s) => {
    const v = (s.sentiment || "").toLowerCase();
    if (v.includes("positive")) return "positive" as const;
    if (v.includes("negative") || v.includes("frustrat")) return "negative" as const;
    if (v.includes("neutral")) return "neutral" as const;
    return "unknown" as const;
  });

  return {
    tenantId: args.tenantId,
    conversationId: args.conversationId ?? null,
    personId,
    crmContactId,
    crmObjectKind,
    vendor: crmBundle.vendor,
    sibling_conversation_ids: relatedIds,
    recent_summaries: summaries,
    open_issues: crmBundle.tasks,
    recent_crm_notes: crmBundle.notes,
    recent_activities: crmBundle.activities,
    sentiment_trend,
    meta: {
      summaries_count: summaries.length,
      open_issues_count: crmBundle.tasks.length,
      crm_notes_count: crmBundle.notes.length,
      activities_count: crmBundle.activities.length,
      siblings_count: relatedIds.length,
      crm_link_reason: crmBundle.reason,
      intel_loaded_ms: intelMs,
      crm_loaded_ms: crmMs,
    },
  };
}
