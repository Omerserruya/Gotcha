/**
 * CRM Panel API helpers — talk to /api/crm on the AI service.
 *
 * Backend routes live in services/ai/src/routes/crm-panel.ts.
 * Mounted via nginx at /api/crm.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function authedFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ─── Types ──────────────────────────────────────────────────

export type CrmObjectKind = "contact" | "lead" | "person_account" | "organization_member" | "company";

export interface CrmContactSummary {
  id: string;
  kind: CrmObjectKind;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  owner_id: string | null;
  stage: string | null;
  custom_fields: Record<string, unknown>;
  vendor_updated_at: string;
  fetched_at: string;
  vendor: string;
}

export interface CrmActivity {
  id: string;
  kind: "note" | "task" | "call" | "email" | "meeting";
  body: string;
  occurred_at: string;
  source_interaction_id: string | null;
}

export interface CrmDeal {
  id: string;
  name: string;
  stage: string | null;
  amount: number | null;
  close_date: string | null;
}

export interface CrmTicket {
  id: string;
  subject: string;
  status: string | null;
  priority: string | null;
}

export type CrmContextStatus =
  | "linked"
  | "unmapped"
  | "no_crm_configured"
  | "found_no_context"
  | "needs_approval";

export interface CrmOpenIssue {
  id: string;
  subject: string;
  description: string | null;
  status: string | null;
  is_open: boolean;
  due_at: string | null;
  owner_id: string | null;
  priority: string | null;
  created_at: string;
  vendor: string;
}

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

export interface CrmContextEnvelope {
  vendor: string | null;
  status: CrmContextStatus;
  contact?: CrmContactSummary | null;
  recent_activities?: CrmActivity[];
  deals?: CrmDeal[];
  tickets?: CrmTicket[];
  /** CRM open issues = incomplete CRM tasks for this contact. */
  open_issues?: CrmOpenIssue[];
  /** Last N AI summaries of prior conversations across every channel. */
  recent_summaries?: RecentSummary[];
  /** Recent CRM notes (vendor-side timeline). */
  recent_crm_notes?: CrmActivity[];
  /** Aggregate sentiment trend (last 5 conversations). */
  sentiment_trend?: ("positive" | "neutral" | "negative" | "unknown")[];
  /** Set when status === "needs_approval" — operator must pick the survivor. */
  candidates?: CrmContactSummary[];
  /** Reason from the identity service (e.g. weak_merge_signal, merge_not_available). */
  link_reason?: string;
  /** Operational metadata when an auto-link/enrich/merge succeeded. */
  link_meta?: {
    outcome?: "linked" | "merged" | "created";
    was_enriched?: boolean;
    merged_from?: string[];
  };
  fallback?: {
    displayName: string | null;
    email: string | null;
    phone: string | null;
  };
}

export interface CreateLeadResponse {
  vendor: string;
  crm_contact_id: string;
  kind: CrmObjectKind;
  outcome?: "created" | "linked" | "merged";
  was_enriched?: boolean;
  merged_from?: string[];
}

// ─── Calls ──────────────────────────────────────────────────

export async function fetchCrmContext(token: string, conversationId: string): Promise<CrmContextEnvelope> {
  const r = await authedFetch<{ data: CrmContextEnvelope }>(`/api/crm/conversation/${conversationId}/context`, token);
  return r.data;
}

export interface CustomerSummary {
  ok: boolean;
  summary: string;
  signals: string[];
  generated_at: string;
  cached: boolean;
  meta: Record<string, unknown>;
}

export async function fetchCustomerSummary(
  token: string,
  conversationId: string,
  opts: { refresh?: boolean; locale?: string } = {},
): Promise<CustomerSummary> {
  const res = await authedFetch<CustomerSummary>("/api/customer-summary", token, {
    method: "POST",
    body: JSON.stringify({
      conversationId,
      refresh: !!opts.refresh,
      locale: opts.locale,
    }),
  });
  return res;
}

export async function createCrmLeadForConversation(token: string, conversationId: string, overrides?: {
  email?: string;
  phone?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  source?: string;
}): Promise<CreateLeadResponse> {
  const r = await authedFetch<{ data: CreateLeadResponse }>(
    `/api/crm/conversation/${conversationId}/create-lead`,
    token,
    { method: "POST", body: JSON.stringify(overrides || {}) },
  );
  return r.data;
}

/**
 * When the identity service returned "needs_approval", the operator picks one
 * candidate from the list. The backend pins that CRM contact to the
 * conversation's GOTCHA Contact and returns the linked envelope.
 */
export async function pickCrmCandidate(
  token: string,
  conversationId: string,
  crm_contact_id: string,
  kind: CrmObjectKind,
): Promise<{ vendor: string; crm_contact_id: string; kind: CrmObjectKind }> {
  const r = await authedFetch<{ data: { vendor: string; crm_contact_id: string; kind: CrmObjectKind } }>(
    `/api/crm/conversation/${conversationId}/pick-candidate`,
    token,
    { method: "POST", body: JSON.stringify({ crm_contact_id, kind }) },
  );
  return r.data;
}

export async function postCrmNote(token: string, conversationId: string, body: string): Promise<{ vendor: string; note_id: string | null; was_update: boolean }> {
  const r = await authedFetch<{ data: { vendor: string; note_id: string | null; was_update: boolean } }>(
    `/api/crm/conversation/${conversationId}/notes`,
    token,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  return r.data;
}

export async function syncCloseToCrm(token: string, conversationId: string): Promise<{
  synced: boolean;
  vendor: string | null;
  crm_activity_id: string | null;
  reason?: string;
}> {
  const r = await authedFetch<{ data: { synced: boolean; vendor: string | null; crm_activity_id: string | null; reason?: string } }>(
    `/api/crm/conversation/${conversationId}/sync-close`,
    token,
    { method: "POST", body: JSON.stringify({}) },
  );
  return r.data;
}
