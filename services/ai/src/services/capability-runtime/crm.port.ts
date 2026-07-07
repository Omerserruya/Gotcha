/**
 * CrmPort — the concrete CRM surface the CRM capability driver runs on.
 *
 * ADAPTER boundary (same shape as CalendarPort): exposes only concrete CRM I/O —
 * "is a CRM connected?" and "search for a customer". It contains NO business rules;
 * every rule (a search key must be known, …) lives ONCE in the operation contracts +
 * verifiers (crm.runtime.ts), never in the port.
 *
 * The production port (crm.port.prod.ts) translates these calls to the EXISTING
 * production CRM code (`getCrmAdapter(tenantId)` → vendor-neutral `CRMAdapter`) — it
 * wraps, it does not reimplement. Tests inject an in-memory fake.
 */

export interface CrmOpContext {
  tenantId: string;
  conversationId: string;
  /** Stable customer key (channel external id). */
  customerExternalId?: string;
  /** Identity hints from the Oracle, used as default search keys. */
  customerEmail?: string;
  customerPhone?: string;
}

/** Slim, vendor-neutral projection of a matched CRM record. */
export interface CrmContactRef {
  id: string;
  kind: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  vendor: string;
}

export interface CrmSearchResult {
  ok: boolean;
  contacts: CrmContactRef[];
  /** Set when the search couldn't run (no_crm_configured, vendor down, …). */
  reason?: string;
}

/** How an upsert resolved the customer's identity. Mirrors the identity service's outcomes. */
export interface CrmUpsertResult {
  status: "created" | "linked" | "merged" | "needs_approval" | "not_found" | "error";
  /** The single canonical contact on a resolved outcome. */
  contact?: CrmContactRef;
  /** On needs_approval: the ambiguous candidates for an operator to disambiguate. */
  candidates?: CrmContactRef[];
  /** On `linked`: whether missing strong identifiers were written back. */
  wasEnriched?: boolean;
  reason?: string;
}

export interface CrmPort {
  /** Concrete: is a CRM connected for this tenant, and which vendor? */
  connection(ctx: CrmOpContext): Promise<{ connected: boolean; vendor: string | null }>;

  /** Concrete: look up matching customer records by phone / email / external id. */
  searchCustomer(
    ctx: CrmOpContext,
    query: { phone?: string; email?: string; external_id?: string },
  ): Promise<CrmSearchResult>;

  /**
   * Concrete: ensure a single canonical customer record exists — resolve if known,
   * create if new, reconcile duplicates (surfacing ambiguous ones for approval).
   * Wraps the production identity-resolution flow.
   */
  upsertCustomer(
    ctx: CrmOpContext,
    hints: { email?: string; phone?: string; name?: string },
  ): Promise<CrmUpsertResult>;

  /** Concrete: record a note on a resolved contact's CRM timeline. */
  addNote(
    ctx: CrmOpContext,
    args: { contactId: string; kind?: string; body: string },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;

  /** Concrete: hydrate a resolved contact — recent activities, open deals, tickets. */
  getContext(
    ctx: CrmOpContext,
    args: { contactId: string; kind?: string },
  ): Promise<{ ok: boolean; context?: { contact: CrmContactRef; activities: number; deals: { name?: string; stage?: string; amount?: number }[]; tickets: { subject?: string; status?: string }[] }; reason?: string }>;

  /** Concrete: sparse-patch fields on a resolved record (only the fields provided). */
  updateRecord(
    ctx: CrmOpContext,
    args: { contactId: string; kind?: string; fields: Record<string, unknown> },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;

  /** Concrete: create a vendor-native task attached to a resolved contact. */
  createTask(
    ctx: CrmOpContext,
    args: { contactId: string; kind?: string; subject: string; body?: string; dueAt?: string },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;
}
