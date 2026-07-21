"use client";

/**
 * CRMPanel - conversation-side panel that hydrates context from the tenant's
 * CRM and lets the agent post a manual note while the conversation is open.
 *
 * Talks to /api/crm/conversation/:id/... (see services/ai/src/routes/crm-panel.ts).
 *
 * Status states:
 *   "linked"             → full context rendered
 *   "unmapped"           → CRM is configured but no match; offer "Create lead"
 *   "no_crm_configured"  → no CRM connected; show CTA to integrations page
 *   "found_no_context"   → adapter found a match but vendor errored on hydrate
 */

import { useState, useEffect, useCallback, Fragment } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import clsx from "clsx";
import {
  fetchCrmContext,
  createCrmLeadForConversation,
  pickCrmCandidate,
  fetchCustomerSummary,
  type CrmContextEnvelope,
  type CustomerSummary,
} from "@/lib/api-crm";
import { CommerceContextPanel } from "./CommerceContextPanel";

interface CRMPanelProps {
  conversation: any;
  onClose?: () => void;
}

export function CRMPanel({ conversation, onClose }: CRMPanelProps) {
  const { token } = useAuth();
  const { t, locale } = useI18n();

  const conversationId = conversation?.id;
  const [ctx, setCtx] = useState<CrmContextEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // AI-generated customer brief - rendered as a highlighted card at the top
  // of the panel. Persistent, customer-level (NOT scoped to this
  // conversation - that's the Co-Pilot context card's job). Refreshed
  // automatically on conversation close + call hangup; the agent can also
  // force-refresh from the card. We pass the active locale so the LLM
  // generates in the agent's language.
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const loadSummary = useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (!token || !conversationId) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await fetchCustomerSummary(token, conversationId, { ...opts, locale });
      setSummary(data);
    } catch (err: any) {
      setSummaryError(err?.message || "Failed to load AI summary");
    } finally {
      setSummaryLoading(false);
    }
  }, [token, conversationId, locale]);

  useEffect(() => {
    setSummary(null);
    loadSummary();
  }, [loadSummary]);
  const [creatingLead, setCreatingLead] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !conversationId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCrmContext(token, conversationId);
      setCtx(data);
    } catch (err: any) {
      setError(err?.message || "failed_to_load");
    } finally {
      setLoading(false);
    }
  }, [token, conversationId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreateLead() {
    if (!token || !conversationId) return;
    setCreatingLead(true);
    setError(null);
    try {
      await createCrmLeadForConversation(token, conversationId);
      // Re-load context - now should be "linked".
      await load();
    } catch (err: any) {
      setError(err?.message || "create_lead_failed");
    } finally {
      setCreatingLead(false);
    }
  }

  async function handlePickCandidate(id: string, kind: string) {
    if (!token || !conversationId) return;
    setPickingId(id);
    setError(null);
    try {
      await pickCrmCandidate(token, conversationId, id, kind as any);
      await load();
    } catch (err: any) {
      setError(err?.message || "pick_candidate_failed");
    } finally {
      setPickingId(null);
    }
  }

  // ─── Layout shell ─────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[340px] bg-white flex flex-col h-full animate-slide-in-right border-l border-gray-100">
      {/* Header */}
      <div className="px-4 py-3 shadow-subtle flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-sm">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5l1.5-1.5 4 4 7.5-7.5L21 6m-9 6.75A2.25 2.25 0 1112 17.25 2.25 2.25 0 0112 12.75zm0 0v6.75" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">{t("crmPanel.title") || "CRM Context"}</p>
          <p className="text-[10px] text-gray-400 truncate">
            {ctx?.vendor ? `via ${ctx.vendor}` : conversation?.customerExternalId}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            aria-label={t("conversations.historyPanel.closeHistory") || "Close"}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Shopify commerce context - self-hides when not connected / not linked. */}
        <CommerceContextPanel conversationId={conversationId} token={token} />

        {loading && (
          <div className="text-xs text-gray-400 px-1">Loading…</div>
        )}

        {!loading && error && (
          <div className="text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-600 border border-rose-100">
            {error}
          </div>
        )}

        {!loading && ctx?.status === "no_crm_configured" && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700 border border-amber-100">
            {t("crmPanel.noCrm") || "No CRM connected. Connect one under Settings → Integrations."}
            <div className="mt-1 text-amber-600">
              {ctx.fallback?.displayName && <div>{ctx.fallback.displayName}</div>}
              {ctx.fallback?.email && <div className="font-mono text-[11px]">{ctx.fallback.email}</div>}
              {ctx.fallback?.phone && <div className="font-mono text-[11px]">{ctx.fallback.phone}</div>}
            </div>
          </div>
        )}

        {!loading && ctx?.status === "needs_approval" && (
          <div className="px-3 py-3 rounded-lg bg-amber-50 text-amber-700 border border-amber-100 space-y-2">
            <div className="text-xs font-medium">
              {t("crmPanel.needsApproval.title") || "Multiple CRM matches found"}
            </div>
            <div className="text-[11px] text-amber-600">
              {t("crmPanel.needsApproval.subtitle") || "Pick the correct record to link this conversation to."}
              {ctx.link_reason && <span className="ml-1 opacity-60">({ctx.link_reason})</span>}
            </div>
            <ul className="space-y-1.5">
              {(ctx.candidates || []).map((cand) => (
                <li key={cand.id} className="rounded-md bg-white border border-amber-100 px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-gray-900 truncate">
                        {cand.display_name || "(no name)"}{" "}
                        <span className="text-[10px] uppercase font-normal text-gray-400">{cand.kind}</span>
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono mt-0.5 space-y-0.5">
                        {cand.email && <div className="truncate">{cand.email}</div>}
                        {cand.phone && <div className="truncate">{cand.phone}</div>}
                        {cand.stage && <div className="text-amber-600">stage: {cand.stage}</div>}
                      </div>
                    </div>
                    <button
                      onClick={() => handlePickCandidate(cand.id, cand.kind)}
                      disabled={pickingId === cand.id}
                      className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition shrink-0"
                    >
                      {pickingId === cand.id
                        ? (t("crmPanel.needsApproval.linking") || "Linking…")
                        : (t("crmPanel.needsApproval.useThis") || "Use this")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && ctx?.status === "unmapped" && (
          <div className="px-3 py-3 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 space-y-2">
            <div className="text-xs">
              {t("crmPanel.unmapped") || "This customer isn't in your CRM yet."}
            </div>
            <div className="text-[11px] text-indigo-600 font-mono space-y-0.5">
              {ctx.fallback?.email && <div>{ctx.fallback.email}</div>}
              {ctx.fallback?.phone && <div>{ctx.fallback.phone}</div>}
            </div>
            <button
              onClick={handleCreateLead}
              disabled={creatingLead}
              className="w-full text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
            >
              {creatingLead
                ? (t("crmPanel.creatingLead") || "Creating…")
                : (t("crmPanel.createLead") || "Create lead in CRM")}
            </button>
          </div>
        )}

        {!loading && ctx?.status === "linked" && ctx.contact && (
          <>
            {/* Highlighted AI customer summary - single source of "what an
                agent needs to know right now" for this customer. Same payload
                will feed Co-Pilot in a follow-up so the human and AI share
                one view. */}
            <AISummaryCard
              summary={summary}
              loading={summaryLoading}
              error={summaryError}
              onRefresh={() => loadSummary({ refresh: true })}
              t={t}
            />
            <CollapsibleSection title={t("crmPanel.sections.contactDetails")} defaultOpen>
              <ContactCardInner contact={ctx.contact} linkMeta={ctx.link_meta} vendor={ctx.vendor} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.openIssues")} badge={(ctx.open_issues || []).length} defaultOpen>
              <OpenIssuesBlock issues={ctx.open_issues || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.sentimentTrend")} badge={(ctx.sentiment_trend || []).length}>
              <SentimentTrendBlock trend={ctx.sentiment_trend || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.crossChannelHistory")} badge={(ctx.recent_summaries || []).length}>
              <RecentSummariesBlock summaries={ctx.recent_summaries || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.recentActivity")} badge={(ctx.recent_activities || []).length}>
              <ActivityBlock activities={ctx.recent_activities || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.crmNotes")} badge={(ctx.recent_crm_notes || []).length}>
              <RecentCrmNotesBlock notes={ctx.recent_crm_notes || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.deals")} badge={(ctx.deals || []).length}>
              <DealsBlock deals={ctx.deals || []} />
            </CollapsibleSection>
            <CollapsibleSection title={t("crmPanel.sections.tickets")} badge={(ctx.tickets || []).length}>
              <TicketsBlock tickets={ctx.tickets || []} />
            </CollapsibleSection>
          </>
        )}

        {!loading && ctx?.status === "found_no_context" && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700 border border-amber-100">
            {t("crmPanel.partial") || "Customer found in CRM but full context unavailable."}
          </div>
        )}

        {/* Manual note composer removed - agents post notes from the
            conversation's normal compose surface. The "CRM notes" collapsible
            above is the read-only timeline pulled from the vendor side. */}
      </div>
    </div>
  );
}

// ─── Section components ──────────────────────────────────

// CHANNEL_FIELD_PLAN mirror (kept in sync with services/ai/src/services/connectors/crm-identity.service.ts).
// Maps a UI-friendly channel name to the CRM custom-field key that holds its external id.
const CHANNEL_FIELD_LABELS: Array<{
  channel: "WhatsApp" | "Instagram" | "Messenger" | "Webchat" | "SMS" | "Voice" | "Email";
  idField: string;
  userField?: string;
  emoji: string;
}> = [
  { channel: "WhatsApp",  idField: "gotcha_wa_id",          emoji: "📱" },
  { channel: "Instagram", idField: "gotcha_psid_instagram", userField: "gotcha_username_instagram", emoji: "📷" },
  { channel: "Messenger", idField: "gotcha_psid_facebook",  userField: "gotcha_username_facebook",  emoji: "💬" },
  { channel: "Webchat",   idField: "gotcha_webchat_id",     emoji: "🌐" },
  { channel: "SMS",       idField: "gotcha_sms_id",         emoji: "✉️" },
  { channel: "Voice",     idField: "gotcha_voice_id",       emoji: "📞" },
  { channel: "Email",     idField: "gotcha_email_id",       emoji: "📧" },
];

// Keys that are surfaced elsewhere on the card OR are GOTCHA bookkeeping -
// hidden from the generic "Other fields" dump so it doesn't repeat info.
const HIDDEN_CUSTOM_FIELDS = new Set<string>([
  ...CHANNEL_FIELD_LABELS.flatMap((c) => [c.idField, c.userField].filter(Boolean) as string[]),
  "gotcha_source_interaction_id",
]);

function ChannelLinks({ customFields }: { customFields: Record<string, unknown> }) {
  const present = CHANNEL_FIELD_LABELS.filter((c) => typeof customFields[c.idField] === "string" && (customFields[c.idField] as string).trim());
  if (present.length === 0) {
    return (
      <div className="text-[11px] text-gray-400 italic">No channel identifiers linked yet - the CRM record has no gotcha_* fields populated.</div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {present.map((c) => {
        const id = customFields[c.idField] as string;
        const username = c.userField ? (customFields[c.userField] as string | undefined) : undefined;
        const display = username ? `@${username}` : id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
        return (
          <span
            key={c.idField}
            title={`${c.channel}: ${id}${username ? ` (@${username})` : ""}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 text-[11px]"
          >
            <span>{c.emoji}</span>
            <span className="font-medium">{c.channel}</span>
            <span className="font-mono text-[10px] text-emerald-600">{display}</span>
          </span>
        );
      })}
    </div>
  );
}

function OtherCustomFields({ customFields }: { customFields: Record<string, unknown> }) {
  const entries = Object.entries(customFields ?? {})
    .filter(([k, v]) => !HIDDEN_CUSTOM_FIELDS.has(k) && v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 pt-2 border-t border-gray-100">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Other CRM fields</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-gray-500 font-mono truncate" title={k}>{k}</dt>
            <dd className="text-gray-800 truncate" title={typeof v === "string" ? v : JSON.stringify(v)}>
              {typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

// Inner version - drops the outer card chrome since CollapsibleSection
// already wraps it. Identical content otherwise.
function ContactCardInner({ contact, linkMeta, vendor }: {
  contact: NonNullable<CrmContextEnvelope["contact"]>;
  linkMeta?: CrmContextEnvelope["link_meta"];
  vendor: string | null;
}) {
  const updated = contact.vendor_updated_at ? new Date(contact.vendor_updated_at) : null;
  return (
    <div className="text-xs space-y-2">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          {contact.kind} {vendor ? `· ${vendor}` : ""}
        </div>
        {linkMeta?.outcome && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100"
            title={linkMeta.was_enriched ? "Identifier enriched on the CRM record" : "Existing CRM record linked"}
          >
            {linkMeta.outcome}{linkMeta.was_enriched ? " · enriched" : ""}
          </span>
        )}
      </div>
      <div className="text-sm font-semibold text-gray-900 truncate">
        {contact.display_name || "(no name)"}
      </div>
      <div className="mt-1.5 text-[11px] text-gray-500 font-mono space-y-0.5">
        {contact.email && <div className="truncate">{contact.email}</div>}
        {contact.phone && <div className="truncate">{contact.phone}</div>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] flex-wrap">
        {contact.stage && (
          <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
            {contact.stage}
          </span>
        )}
        {contact.owner_id && (
          <span className="px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-100 truncate max-w-[140px]" title={contact.owner_id}>
            owner: {contact.owner_id.slice(0, 8)}
          </span>
        )}
      </div>

      {/* Linked channels - pulls from custom_fields where the CRM stores
          the GOTCHA-prefixed identifiers (gotcha_psid_instagram, gotcha_wa_id,
          etc). Empty when the CRM record only has phone/email and no channel
          identifiers wired yet. */}
      <div className="mt-3 pt-2 border-t border-gray-100">
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Linked channels</div>
        <ChannelLinks customFields={contact.custom_fields ?? {}} />
      </div>

      {/* Everything else the CRM record carries that isn't already surfaced. */}
      <OtherCustomFields customFields={contact.custom_fields ?? {}} />

      <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between text-[10px] text-gray-400">
        <span className="font-mono truncate" title={contact.id}>id: {contact.id.slice(0, 12)}…</span>
        {updated && <span title={updated.toISOString()}>synced {updated.toLocaleString()}</span>}
      </div>
    </div>
  );
}

function ActivityBlock({ activities }: { activities: NonNullable<CrmContextEnvelope["recent_activities"]> }) {
  if (!activities.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">Recent activity</div>
      <ul className="space-y-1.5">
        {activities.map((a) => (
          <li key={a.id} className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 uppercase">{a.kind}</span>
              <span className="text-[10px] text-gray-400">{new Date(a.occurred_at).toLocaleString()}</span>
            </div>
            <div className="text-xs text-gray-700 mt-0.5 line-clamp-2">{a.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DealsBlock({ deals }: { deals: NonNullable<CrmContextEnvelope["deals"]> }) {
  if (!deals.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">Deals</div>
      <ul className="space-y-1.5">
        {deals.map((d) => (
          <li key={d.id} className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
            <div className="text-xs font-medium text-gray-800 truncate">{d.name}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              {d.stage && <span className="mr-2">{d.stage}</span>}
              {d.amount != null && <span className="font-mono">{d.amount}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpenIssuesBlock({ issues }: { issues: NonNullable<CrmContextEnvelope["open_issues"]> }) {
  if (!issues.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">
        Open Issues ({issues.length})
      </div>
      <ul className="space-y-1.5">
        {issues.map((iss) => (
          <li key={iss.id} className="rounded-md bg-white border border-amber-200 px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-amber-800 truncate">{iss.subject}</div>
                {iss.description && (
                  <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-2">{iss.description}</div>
                )}
                <div className="text-[10px] text-gray-500 mt-1 space-x-2">
                  {iss.status && <span className="font-mono">{iss.status}</span>}
                  {iss.due_at && <span>due: {new Date(iss.due_at).toLocaleDateString()}</span>}
                  {iss.priority && <span>priority: {iss.priority}</span>}
                </div>
              </div>
              {iss.is_open && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">open</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentSummariesBlock({ summaries }: { summaries: NonNullable<CrmContextEnvelope["recent_summaries"]> }) {
  if (!summaries.length) return null;
  const others = summaries.filter((s) => !s.isCurrentConversation);
  if (!others.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">
        Recent conversations ({others.length})
      </div>
      <ul className="space-y-1.5">
        {others.map((s) => (
          <li key={s.conversationId} className="rounded-md bg-white border border-gray-100 px-2.5 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 uppercase">{s.channel}</span>
              <span className="text-[10px] text-gray-400">{new Date(s.occurredAt).toLocaleDateString()}</span>
            </div>
            {s.summary && (
              <p className="text-xs text-gray-700 mt-0.5 line-clamp-3">{s.summary}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {s.sentiment && (
                <span className={clsx(
                  "text-[10px] px-1.5 py-0.5 rounded-full",
                  s.sentiment.toLowerCase().includes("positive") && "bg-emerald-50 text-emerald-700",
                  s.sentiment.toLowerCase().includes("negative") && "bg-rose-50 text-rose-700",
                  s.sentiment.toLowerCase().includes("neutral") && "bg-gray-100 text-gray-600",
                )}>
                  {s.sentiment}
                </span>
              )}
              {s.qualification && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                  {s.qualification}
                </span>
              )}
              {s.actionItems.slice(0, 2).map((a, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 truncate max-w-[160px]">
                  • {a}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SentimentTrendBlock({ trend }: { trend: NonNullable<CrmContextEnvelope["sentiment_trend"]> }) {
  if (!trend.length) return null;
  return (
    <div className="rounded-md bg-white border border-gray-100 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Sentiment trend</div>
      <div className="flex items-center gap-1">
        {trend.map((v, i) => (
          <span
            key={i}
            title={v}
            className={clsx(
              "h-2 flex-1 rounded-sm",
              v === "positive" && "bg-emerald-400",
              v === "negative" && "bg-rose-400",
              v === "neutral"  && "bg-gray-300",
              v === "unknown"  && "bg-gray-200",
            )}
          />
        ))}
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5">most-recent →</div>
    </div>
  );
}

function RecentCrmNotesBlock({ notes }: { notes: NonNullable<CrmContextEnvelope["recent_crm_notes"]> }) {
  if (!notes.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">CRM notes</div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id} className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 uppercase">{n.kind}</span>
              <span className="text-[10px] text-gray-400">{new Date(n.occurred_at).toLocaleDateString()}</span>
            </div>
            <div className="text-xs text-gray-700 mt-0.5 line-clamp-3 whitespace-pre-wrap">{n.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Collapsible section wrapper - gives every CRM-panel category an
// independent expand/collapse with a chevron. State lives in-component so
// each section remembers its open/closed during the session.
function CollapsibleSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isEmpty = typeof badge === "number" && badge === 0;
  return (
    <div className="rounded-lg border border-gray-100 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50/60 transition rounded-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">{title}</span>
          {typeof badge === "number" && (
            <span className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded-full font-mono",
              isEmpty ? "bg-gray-100 text-gray-400" : "bg-violet-100 text-violet-700",
            )}>
              {badge}
            </span>
          )}
        </div>
        <svg
          className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform", open && "rotate-180")}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          {isEmpty ? (
            <div className="text-[11px] text-gray-400 italic">No items.</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// Highlighted AI customer-brief card at the top of the panel. Gradient
// shell so it visually anchors above the structured CRM blocks. Shows the
// model-generated behavioral brief plus short "signals" pills, preferred
// tone, current mood, and recommended-behavior chips - everything the agent
// needs to make THIS customer feel good on the next interaction.
//
// The brief is persistent + cross-channel: it's refreshed by the post-chat
// subscriber (chat close) and voice-postcall worker (call hangup) so a
// fresh value is on disk before the next conversation opens.
function AISummaryCard({
  summary,
  loading,
  error,
  onRefresh,
  t,
}: {
  summary: CustomerSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const tone = typeof summary?.meta?.tone === "string" ? (summary.meta.tone as string) : null;
  const mood = typeof summary?.meta?.mood === "string" ? (summary.meta.mood as string) : null;
  const recommendedBehaviors = Array.isArray(summary?.meta?.recommended_behaviors)
    ? (summary!.meta!.recommended_behaviors as string[])
    : [];
  const channels = Array.isArray(summary?.meta?.channels)
    ? (summary!.meta!.channels as string[])
    : [];
  const lastSourceChannel = typeof summary?.meta?.last_source_channel === "string"
    ? (summary!.meta!.last_source_channel as string)
    : null;
  const convCount = typeof summary?.meta?.conversation_count === "number"
    ? (summary!.meta!.conversation_count as number)
    : null;

  return (
    <div className="relative rounded-xl p-[1.5px] bg-gradient-to-br from-violet-500 via-purple-500 to-pink-500 shadow-sm">
      <div className="rounded-[11px] bg-white p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </span>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-wide bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                {t("crmPanel.brief.title")}
              </span>
              <span className="text-[9px] text-gray-400 -mt-0.5">
                {channels.length > 1
                  ? t("crmPanel.brief.acrossN", { count: String(channels.length) })
                  : t("crmPanel.brief.across")}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="text-[10px] text-violet-500 hover:text-violet-700 disabled:opacity-40 transition"
            title={t("crmPanel.brief.refresh")}
          >
            {loading ? "…" : "↻"}
          </button>
        </div>
        {error && <div className="text-[11px] text-rose-600">{error}</div>}
        {!error && loading && !summary && (
          <div className="text-[11px] text-gray-400 italic">{t("crmPanel.brief.generating")}</div>
        )}
        {!error && summary && (
          <>
            <p className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">
              {summary.summary}
            </p>

            {/* Mood + tone - short behavioral tags right under the prose. */}
            {(mood || tone) && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                {mood && (
                  <span className="px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.mood")}:</span>{mood}
                  </span>
                )}
                {tone && (
                  <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.tone")}:</span>{tone}
                  </span>
                )}
              </div>
            )}

            {summary.signals && summary.signals.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {summary.signals.map((s, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}

            {/* Concrete actions for the next agent. The brief tells them
                what the customer feels - this list tells them what to DO. */}
            {recommendedBehaviors.length > 0 && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <div className="text-[9px] uppercase tracking-wide text-gray-500 mb-1">{t("crmPanel.brief.howToTreat")}</div>
                <ul className="space-y-0.5">
                  {recommendedBehaviors.map((b, i) => (
                    <li key={i} className="text-[11px] text-gray-700 flex items-start gap-1">
                      <span className="text-emerald-500 mt-0.5">✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1.5 text-[9px] text-gray-400 flex items-center justify-between">
              <span>
                {summary.cached ? t("crmPanel.brief.saved") : t("crmPanel.brief.fresh")} · {new Date(summary.generated_at).toLocaleString()}
              </span>
              <span className="text-right">
                {convCount != null && convCount > 0 && (
                  <span>
                    {convCount === 1
                      ? t("crmPanel.brief.priorConv", { count: String(convCount) })
                      : t("crmPanel.brief.priorConvs", { count: String(convCount) })}
                  </span>
                )}
                {lastSourceChannel && (
                  <span className="ml-1 text-gray-300">· {t("crmPanel.brief.lastChannel", { channel: lastSourceChannel.toLowerCase() })}</span>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TicketsBlock({ tickets }: { tickets: NonNullable<CrmContextEnvelope["tickets"]> }) {
  if (!tickets.length) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 px-1">Tickets</div>
      <ul className="space-y-1.5">
        {tickets.map((tk) => (
          <li key={tk.id} className="rounded-md bg-white border border-gray-100 px-2.5 py-1.5">
            <div className="text-xs font-medium text-gray-800 truncate">{tk.subject}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              {tk.status && <span className="mr-2">{tk.status}</span>}
              {tk.priority && <span>priority: {tk.priority}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
