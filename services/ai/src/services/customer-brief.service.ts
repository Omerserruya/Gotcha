/**
 * Customer Brief — persistent, customer-level behavioral intelligence.
 *
 * The per-conversation summary answers "what happened in this thread?". The
 * customer brief answers "who is this person, and how should I treat them?"
 * — and lives BEYOND any single conversation so the next agent (or AI) can
 * pick up cold.
 *
 * Refresh hooks:
 *   • post-chat subscriber (conversation:closed for non-voice)
 *   • voice-postcall worker (FINALIZED stage)
 * Both run in parallel with the per-conversation summary so the brief is
 * fresh before the next interaction starts. Best-effort: failures here NEVER
 * block conversation close.
 *
 * Storage: `customer_briefs` (one row per tenant+identityKey+locale). The
 * identity key prefers `person:<id>` > `crm:<vendor>:<id>` > `contact:<id>`
 * — when the unifier converges later, the writer will move briefs onto the
 * stronger key automatically (next refresh writes under the new key).
 *
 * Locale-aware: a tenant with Hebrew and English agents gets one persisted
 * brief per language without re-asking the LLM each time.
 */

import { prisma } from "@chatcenter/shared";
import { loadCustomerContext, type CustomerContextBundle } from "./memory/customer-context.service";
import { generateResponse, getDefaultModel } from "./ai.service";

export interface CustomerBriefRecord {
  id: string;
  identityKey: string;
  brief: string;
  signals: string[];
  tone: string | null;
  mood: string | null;
  recommendedBehaviors: string[];
  channels: string[];
  conversationCount: number;
  lastSourceChannel: string | null;
  lastSourceConvId: string | null;
  generatedAt: string;
  locale: string;
  vendor: string | null;
  meta: {
    crm_linked: boolean;
    person_linked: boolean;
  };
}

interface IdentityHints {
  personId?: string | null;
  crmContactId?: string | null;
  crmVendor?: string | null;
  contactId?: string | null;
}

/**
 * Pick the strongest identity key available. The same human may have
 * multiple keys until the identity layers converge (personId from the
 * unifier + crmContactId from the operator). We always write under the
 * strongest; older keys go stale and the next read re-targets.
 */
export function deriveIdentityKey(h: IdentityHints): string | null {
  if (h.personId) return `person:${h.personId}`;
  if (h.crmContactId) return `crm:${h.crmVendor ?? "_"}:${h.crmContactId}`;
  if (h.contactId) return `contact:${h.contactId}`;
  return null;
}

const LOCALE_NAME: Record<string, string> = {
  he: "Hebrew", ar: "Arabic", en: "English", es: "Spanish",
  fr: "French", de: "German", pt: "Portuguese", ru: "Russian",
  zh: "Chinese", ja: "Japanese",
};


// ─── Read ──────────────────────────────────────────────────

/**
 * Look up the freshest brief for a customer. Queries the indexed identity
 * COLUMNS (personId / crmContactId / contactId) rather than the composite
 * identityKey — the column query survives vendor-string drift (e.g. a row
 * written when contact.metadata.crmVendor was null vs. "zoho") which would
 * otherwise produce false cache misses and force regeneration on every
 * panel open.
 */
export async function getCustomerBrief(args: {
  tenantId: string;
  hints: IdentityHints;
  locale?: string;
}): Promise<CustomerBriefRecord | null> {
  const locale = (args.locale || "en").toLowerCase().slice(0, 8);

  const orFilters: Array<Record<string, unknown>> = [];
  if (args.hints.personId) orFilters.push({ personId: args.hints.personId });
  if (args.hints.crmContactId) orFilters.push({ crmContactId: args.hints.crmContactId });
  if (args.hints.contactId) orFilters.push({ contactId: args.hints.contactId });
  if (orFilters.length === 0) return null;

  const row = await (prisma as any).customerBrief.findFirst({
    where: {
      tenantId: args.tenantId,
      locale,
      OR: orFilters,
    },
    orderBy: { generatedAt: "desc" },
  });
  if (!row) return null;
  return mapRow(row);
}

// ─── Write / refresh ───────────────────────────────────────

export async function refreshCustomerBriefFromConversation(args: {
  tenantId: string;
  conversationId: string;
  locale?: string;
  /** Optional event name for provenance — e.g. "chat.closed" or "voice.finalized". */
  sourceEvent?: string;
}): Promise<CustomerBriefRecord | null> {
  const locale = (args.locale || "en").toLowerCase().slice(0, 8);

  // Pull the cross-channel bundle. loadCustomerContext walks Contact.personId
  // and metadata.crmContactId — same path the side panel uses, so the brief
  // sees exactly the data the operator does.
  const bundle = await loadCustomerContext({
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    summaryLimit: 10,
    crmNoteLimit: 10,
  });

  // Need at least one identity anchor to persist under. Without any, the
  // brief would be untargetable on the next conversation.
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { channel: true, customerExternalId: true, customerName: true },
  });
  // We need contactId for the weakest-key fallback. Try the exact
  // (channel, externalId) tuple first; if nothing matches and the
  // customerExternalId is phone-shaped (voice / WhatsApp / SMS), fall back
  // to a phone-column lookup so we cross channels — the same human ingested
  // first on WhatsApp resolves on a later voice call.
  let contactId: string | null = null;
  if (conv?.channel && conv?.customerExternalId) {
    const c = await (prisma as any).contact.findFirst({
      where: { tenantId: args.tenantId, channel: conv.channel, externalId: conv.customerExternalId },
      select: { id: true },
    });
    contactId = c?.id ?? null;
    if (!contactId) {
      const normalized = conv.customerExternalId.replace(/[\s-]/g, "");
      if (/^\+?\d{6,}$/.test(normalized)) {
        const candidates = Array.from(new Set([
          conv.customerExternalId,
          normalized,
          normalized.startsWith("+") ? normalized.slice(1) : `+${normalized}`,
        ]));
        const xchannel = await (prisma as any).contact.findFirst({
          where: { tenantId: args.tenantId, mergedIntoId: null, phone: { in: candidates } },
          select: { id: true },
        });
        contactId = xchannel?.id ?? null;
      }
    }
  }

  const hints: IdentityHints = {
    personId: bundle.personId,
    crmContactId: bundle.crmContactId,
    crmVendor: bundle.vendor,
    contactId,
  };
  const identityKey = deriveIdentityKey(hints);
  if (!identityKey) {
    // No identity at all — nothing to persist under. Skip silently.
    return null;
  }

  // Sibling conversations come pre-computed on the bundle — the walk
  // unions every identity layer (personId + CRM pin + phone + email),
  // mirroring conversation.service.ts:getHistoryByCustomerExternalId so
  // the brief sees exactly the same prior history the side panel does.
  // We exclude the current conversation explicitly since the brief is
  // strictly cross-conversation.
  const siblingConvIds = bundle.sibling_conversation_ids.filter((id) => id !== args.conversationId).slice(0, 20);

  // Sample inbound (customer-voiced) messages from sibling conversations.
  // These ARE the prior history — what the customer actually said over
  // time. The brief grounds entirely on this; the current conversation is
  // intentionally excluded since CoPilot owns that surface.
  const priorMessageSamples: Array<{ conversationId: string; channel: string; direction: string; body: string; createdAt: string }> = [];
  if (siblingConvIds.length > 0) {
    const convMeta = await prisma.conversation.findMany({
      where: { tenantId: args.tenantId, id: { in: siblingConvIds } },
      select: { id: true, channel: true },
    });
    const channelByConv: Record<string, string> = {};
    for (const c of convMeta) channelByConv[c.id] = String(c.channel);

    const sampled = await prisma.message.findMany({
      where: {
        tenantId: args.tenantId,
        conversationId: { in: siblingConvIds },
        direction: "INBOUND",
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { conversationId: true, body: true, direction: true, createdAt: true },
    });
    for (const m of sampled) {
      if (!m.conversationId) continue;
      priorMessageSamples.push({
        conversationId: m.conversationId,
        channel: channelByConv[m.conversationId] ?? "?",
        direction: m.direction as string,
        body: m.body ?? "",
        createdAt: m.createdAt.toISOString(),
      });
    }
  }

  console.log(
    `[customer-brief] generating tenant=${args.tenantId} conv=${args.conversationId} ` +
    `personId=${bundle.personId ?? "-"} crm=${bundle.crmContactId ?? "-"} ` +
    `siblings=${siblingConvIds.length} summaries=${bundle.recent_summaries.length} ` +
    `samples=${priorMessageSamples.length}`,
  );

  const { brief, signals, tone, mood, recommendedBehaviors } = await generateBriefText({
    tenantId: args.tenantId,
    bundle,
    locale,
    customerName: conv?.customerName ?? null,
    currentChannel: conv?.channel ?? null,
    priorMessageSamples,
    siblingConversationCount: siblingConvIds.length,
  });

  const channels = Array.from(new Set(bundle.recent_summaries.map((s) => s.channel).filter(Boolean)));

  const record = await (prisma as any).customerBrief.upsert({
    where: {
      tenantId_identityKey_locale: {
        tenantId: args.tenantId,
        identityKey,
        locale,
      },
    },
    create: {
      tenantId: args.tenantId,
      identityKey,
      personId: bundle.personId,
      crmContactId: bundle.crmContactId,
      crmObjectKind: bundle.crmObjectKind,
      contactId,
      locale,
      brief,
      signals,
      tone,
      mood,
      recommendedBehaviors,
      channels,
      conversationCount: bundle.recent_summaries.length,
      lastSourceChannel: conv?.channel ?? null,
      lastSourceConvId: args.conversationId,
      lastSourceEvent: args.sourceEvent ?? null,
      generatedAt: new Date(),
    },
    update: {
      personId: bundle.personId,
      crmContactId: bundle.crmContactId,
      crmObjectKind: bundle.crmObjectKind,
      contactId,
      brief,
      signals,
      tone,
      mood,
      recommendedBehaviors,
      channels,
      conversationCount: bundle.recent_summaries.length,
      lastSourceChannel: conv?.channel ?? null,
      lastSourceConvId: args.conversationId,
      lastSourceEvent: args.sourceEvent ?? null,
      generatedAt: new Date(),
    },
  });
  return mapRow(record);
}

// ─── LLM call ──────────────────────────────────────────────

async function generateBriefText(args: {
  tenantId: string;
  bundle: CustomerContextBundle;
  locale: string;
  customerName: string | null;
  currentChannel: string | null;
  /** Verbatim customer messages sampled from PRIOR conversations across
   *  every channel. Excludes the current conversation by design — the
   *  CoPilot context card owns "what's happening right now". This brief
   *  is purely about the customer's behavioral arc over time. */
  priorMessageSamples: Array<{ conversationId: string; channel: string; direction: string; body: string; createdAt: string }>;
  /** Count of distinct prior conversations found via the identity walk
   *  (personId + CRM pin). Used to communicate scope to the LLM even when
   *  the message-sample window doesn't cover all of them. */
  siblingConversationCount: number;
}): Promise<{
  brief: string;
  signals: string[];
  tone: string | null;
  mood: string | null;
  recommendedBehaviors: string[];
}> {
  const { bundle, priorMessageSamples, siblingConversationCount } = args;
  const targetLanguage = LOCALE_NAME[args.locale] || "English";

  const profileLines: string[] = [];
  if (args.customerName) profileLines.push(`Customer name: ${args.customerName}`);
  if (bundle.crmContactId) {
    profileLines.push(`CRM record: ${bundle.crmObjectKind ?? "?"}:${bundle.crmContactId} (${bundle.vendor ?? "no vendor"})`);
  }
  if (bundle.personId) profileLines.push(`Unified identity (personId): ${bundle.personId}`);
  profileLines.push(`Total prior conversations on file (excluding the current one): ${siblingConversationCount}`);
  if (args.currentChannel) {
    profileLines.push(`(Current conversation channel: ${args.currentChannel} — DO NOT summarize the current conversation; another surface owns that.)`);
  }

  // Cross-channel summaries from ConversationIntelligence — the high-signal
  // path. Excludes the current conversation by design.
  const otherSummaries = bundle.recent_summaries.filter((s) => !s.isCurrentConversation);
  if (otherSummaries.length > 0) {
    profileLines.push("", "## Prior conversation summaries (cross-channel, most-recent first)");
    for (const s of otherSummaries.slice(0, 10)) {
      const head: string[] = [`[${s.channel} ${s.occurredAt.slice(0, 10)}]`];
      if (s.sentiment) head.push(`sentiment=${s.sentiment}`);
      if (s.qualification) head.push(`qualification=${s.qualification}`);
      profileLines.push(`- ${head.join(" ")}`);
      if (s.summary) profileLines.push(`  ${s.summary.slice(0, 320)}`);
      if (s.actionItems && s.actionItems.length) {
        profileLines.push(`  outstanding: ${s.actionItems.slice(0, 3).join("; ")}`);
      }
    }
  }

  // Verbatim customer messages from prior conversations. This is the
  // anti-hallucination anchor — when ConversationIntelligence summaries
  // are missing or stale, the LLM still has real text to quote from.
  if (priorMessageSamples.length > 0) {
    profileLines.push("", "## Verbatim customer messages from PRIOR conversations (most-recent first)");
    profileLines.push("(These are the customer's own words across past interactions. Cite specific topics they mentioned.)");
    for (const m of priorMessageSamples.slice(0, 20)) {
      const body = (m.body || "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (body) profileLines.push(`- [${m.channel} ${m.createdAt.slice(0, 10)}] ${body}`);
    }
  }

  if (bundle.open_issues.length > 0) {
    profileLines.push("", "## Open CRM tasks (cross-conversation)");
    for (const i of bundle.open_issues.slice(0, 6)) {
      const head: string[] = [];
      if ((i as any).priority) head.push(`[${(i as any).priority}]`);
      if ((i as any).status) head.push(`(${(i as any).status})`);
      head.push((i as any).subject ?? "");
      if ((i as any).due_at) head.push(`due ${(i as any).due_at}`);
      profileLines.push(`- ${head.join(" ")}`);
    }
  }

  if (bundle.recent_crm_notes.length > 0) {
    profileLines.push("", "## Recent CRM notes");
    for (const n of bundle.recent_crm_notes.slice(0, 5)) {
      profileLines.push(`- ${(n as any).body?.slice(0, 240) || ""}`);
    }
  }

  if (bundle.sentiment_trend.length > 0) {
    profileLines.push("", `## Sentiment trend across prior conversations (most-recent first): ${bundle.sentiment_trend.join(", ")}`);
  }

  const profile = profileLines.join("\n");

  // STRICT scope rule: the brief is about WHO THIS CUSTOMER IS over time —
  // not what's happening in the current conversation. CoPilot has its own
  // context card for that. Duplicating that scope is wasteful and confuses
  // the agent's attention.
  const systemPrompt = [
    "You are a senior customer-relationship analyst writing a CROSS-CONVERSATION behavioral brief about a single customer.",
    "Audience: the human agent who will talk to this customer — they already have a separate \"current conversation\" surface (CoPilot), so do NOT describe what's happening right now.",
    "",
    `WRITE EVERY STRING IN ${targetLanguage.toUpperCase()}. The platform is operating in ${targetLanguage} — both \`brief\` and every entry in \`signals\` / \`recommended_behaviors\` MUST be in ${targetLanguage}.`,
    "",
    "SCOPE RULES (strict — violations make the brief useless):",
    "1. The brief is about the customer's HISTORICAL behavior across all prior conversations.",
    "2. NEVER mention what they sent in the current conversation, what file they attached, what number they shared just now, or anything else about the live interaction. That is CoPilot's territory.",
    "3. If you have zero prior history, write a short honest brief that says so — DO NOT pad by describing the current conversation.",
    "",
    "ANTI-HALLUCINATION RULES:",
    "4. Never invent intent. If the prior messages / summaries don't show it, don't write it.",
    "5. Never write filler like \"asking about wellbeing\", \"checking in\", \"reaching out to say hi\" unless those exact intents appear in prior messages.",
    "6. NAME concrete topics from prior conversations — products, features, prices, complaints, requests they actually wrote about.",
    "7. If you cite a topic, it must be quotable from the profile.",
    "",
    "BEHAVIORAL DEPTH (this is the value the brief adds):",
    "- Arc across channels: how have they engaged with the business over time?",
    "- Mood pattern: are they consistently warm, frustrated, neutral, sharp, etc?",
    "- Tone preference: how do they like to be talked to (formal/casual, short/long, language)?",
    "- Recurring topics / unresolved issues / past product interest.",
    "- Disappointment + churn signals matter more than positive signals — surface them clearly.",
    "- What would make THIS person feel good and well-treated on the next interaction?",
    "",
    "Output JSON with EXACTLY this shape:",
    "{",
    '  "brief": "3-5 short sentences about who they are across ALL prior interactions. Cover: their recurring interests / requests across channels (name them), their relationship arc, any unresolved issues, dominant mood with evidence, and what they respond well to. NO mention of the current conversation.",',
    '  "signals": ["≤5 short noun phrases — historical things to keep in mind (e.g. \\"asked about GOTCHA pricing twice in the past month\\", \\"prefers Hebrew\\", \\"unresolved billing issue from 2026-03-12\\")"],',
    '  "tone": "tone this customer responds to best, inferred from how they wrote in past conversations — short phrase. null if no signal.",',
    '  "mood": "dominant mood across PRIOR interactions with evidence — short phrase. null if no signal.",',
    '  "recommended_behaviors": ["≤5 concrete things the next agent should DO based on the customer\'s history — e.g. \\"follow up on his GOTCHA pricing question from last week\\", \\"acknowledge the unresolved billing issue first\\". NOT instructions about the current conversation."]',
    "}",
  ].join("\n");

  try {
    const result = await generateResponse({
      tenantId: args.tenantId,
      // Per-contact brief — pin to the strongest available identity so
      // repeat briefs for the same person route to the same backend cache.
      sessionId: args.bundle.personId
        ? `person:${args.bundle.personId}`
        : args.bundle.crmContactId
          ? `crm:${args.bundle.crmContactId}`
          : undefined,
      model: getDefaultModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `## Profile\n${profile || "(no profile data yet — brand-new customer with zero messages on record)"}` },
      ],
      temperature: 0.2,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
      metadata: { type: "customer_brief" },
    });
    if (!result.content) throw new Error("empty_llm_response");
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    const briefText = typeof parsed.brief === "string" ? parsed.brief.trim() : "";
    const signals = Array.isArray(parsed.signals)
      ? parsed.signals.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 5)
      : [];
    const tone = typeof parsed.tone === "string" && parsed.tone.trim() ? parsed.tone.trim() : null;
    const mood = typeof parsed.mood === "string" && parsed.mood.trim() ? parsed.mood.trim() : null;
    const recommendedBehaviors = Array.isArray(parsed.recommended_behaviors)
      ? parsed.recommended_behaviors.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 5)
      : [];

    return {
      brief: briefText || fallbackBrief(args.locale, bundle.recent_summaries.length > 0),
      signals,
      tone,
      mood,
      recommendedBehaviors,
    };
  } catch (err: any) {
    console.warn("[customer-brief] LLM failed:", err?.message);
    return {
      brief: fallbackBrief(args.locale, bundle.recent_summaries.length > 0),
      signals: [],
      tone: null,
      mood: null,
      recommendedBehaviors: [],
    };
  }
}

function fallbackBrief(locale: string, hasHistory: boolean): string {
  const fallbacks: Record<string, { returning: string; newCustomer: string }> = {
    he: {
      returning: "לקוח חוזר — ראה שיחות קודמות להקשר.",
      newCustomer: "לקוח חדש — אין אינטראקציות קודמות מתועדות.",
    },
    en: {
      returning: "Returning customer — see prior conversations for context.",
      newCustomer: "New customer with no recorded prior interactions.",
    },
  };
  const fb = fallbacks[locale] ?? fallbacks.en!;
  return hasHistory ? fb.returning : fb.newCustomer;
}

function mapRow(row: any): CustomerBriefRecord {
  return {
    id: row.id,
    identityKey: row.identityKey,
    brief: row.brief,
    signals: Array.isArray(row.signals) ? row.signals : [],
    tone: row.tone ?? null,
    mood: row.mood ?? null,
    recommendedBehaviors: Array.isArray(row.recommendedBehaviors) ? row.recommendedBehaviors : [],
    channels: Array.isArray(row.channels) ? row.channels : [],
    conversationCount: row.conversationCount ?? 0,
    lastSourceChannel: row.lastSourceChannel ?? null,
    lastSourceConvId: row.lastSourceConvId ?? null,
    generatedAt: (row.generatedAt ?? row.updatedAt ?? new Date()).toISOString?.() ?? new Date().toISOString(),
    locale: row.locale,
    // We don't pin a vendor name on the brief — consumers that need the
    // current vendor read it from the CRM adapter at panel-render time
    // (which is where vendor strings actually mean something).
    vendor: null,
    meta: {
      crm_linked: !!row.crmContactId,
      person_linked: !!row.personId,
    },
  };
}
