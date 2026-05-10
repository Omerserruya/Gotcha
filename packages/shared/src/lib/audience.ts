/**
 * Audience definition + resolver.
 *
 * Powers explicit targeting for outbound campaigns / broadcasts:
 * the operator declares WHO should receive a message, and this layer
 * returns the resolved recipient list. No more "send to everyone".
 *
 * Audience types:
 *
 *   {type:"manual",  contactIds:[...]}
 *     Explicit list. Used by the UI when the operator picks individual
 *     contacts.
 *
 *   {type:"filter",  rules:{ all|any:[Filter...] }}
 *     Dynamic segment. Each Filter is `{field, op, value}` evaluated
 *     against local Contact rows AND (for the basic identity fields:
 *     name/phone/email/company) against the connected CRM via the
 *     shared `crm.ts` client.
 *
 *   {type:"composite", contactIds?, rules?, everyone?}
 *     The shape the new broadcast wizard builds: a single audience can
 *     mix hand-picked chips (`contactIds`), filter rules, and an
 *     "everyone reachable" flag. Resolution unions all three.
 *
 *   {type:"saved",   audienceId:"..."}
 *     Reusable definition stored elsewhere (TODO: SavedAudience table).
 *
 * The preview / resolve API is consumed by the broadcast builder UI
 * (preview before send) and by the broadcast send worker (final
 * recipient enumeration just before fan-out).
 */

import { prisma } from "./prisma";
import {
  getConnectedCrm,
  searchContacts as crmSearchContacts,
  searchLeads as crmSearchLeads,
  searchByRules,
  type CrmRecord,
  type CrmLookupArgs,
  type CrmFilterRule,
} from "./crm";

// ─── Types ──────────────────────────────────────────────────

export type FilterOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "exists"
  | "not_exists"
  | "in_last_days"   // value: number of days back from now (date fields)
  | "before"         // value: ISO date (date fields)
  | "after";         // value: ISO date (date fields)

export interface AudienceFilter {
  /** Logical field name (`displayName`, `phone`, `email`, `tags`,
   *  `city`, `lifecycle_stage`, etc.). Cross-source: if the field
   *  doesn't exist on the local Contact, the resolver tries the
   *  connected CRM (for the basic identity fields). */
  field: string;
  op: FilterOp;
  /** Right-hand side. Type depends on op. For `in`/`not_in` use array. */
  value?: unknown;
}

export interface AudienceFilterGroup {
  /** Logical AND of all filters. */
  all?: AudienceFilter[];
  /** Logical OR of all filters. */
  any?: AudienceFilter[];
}

/** Which CRM module the rules target. Defaults to "leads" for backward
 *  compat with audiences saved before the selector existed. */
export type AudienceModule = "leads" | "contacts" | "accounts" | "deals";

/**
 * A hand-picked CRM record stored on the audience definition. We snapshot
 * the identity fields so the broadcast send path can produce a recipient
 * without re-hitting the CRM at fan-out time.
 */
export interface CrmPickedContact {
  /** CRM-side id (Zoho/HubSpot/Salesforce record id). */
  id: string;
  displayName?: string;
  phone?: string;
  email?: string;
}

export type AudienceDefinition =
  | {
      type: "manual";
      contactIds: string[];
      /** CRM-picked chips that don't have a platform Contact row. */
      crmContacts?: CrmPickedContact[];
    }
  | { type: "filter"; rules: AudienceFilterGroup; module?: AudienceModule }
  | { type: "saved"; audienceId: string }
  | {
      type: "composite";
      /** Hand-picked local Contact ids. */
      contactIds?: string[];
      /** Hand-picked CRM records (no platform Contact row). */
      crmContacts?: CrmPickedContact[];
      /** Filter rules. */
      rules?: AudienceFilterGroup;
      /** When true, expand to every Contact in the tenant (with optional channel scope). */
      everyone?: boolean;
      /** Optional channel scope for the "everyone" flag. */
      channel?: string;
      /** CRM module the rules target ("leads"|"contacts"|"accounts"|"deals"). */
      module?: AudienceModule;
    };

export interface ResolvedRecipient {
  /** Local Contact id (when known) or a synthetic id like `crm:<crmRowId>`. */
  id: string;
  /** Original CRM record id (when source==="crm"). Used for traceability
   *  and as the lookup key when re-fetching enrichment fields. */
  crmRecordId?: string;
  /** Provider-native field map for the recipient (when source==="crm"
   *  and we resolved them via filter/rules). Used at broadcast
   *  materialize time to snapshot per-recipient template variable
   *  values. Picked CRM chips don't carry this — only the snapshot
   *  fields below. */
  raw?: Record<string, unknown>;
  source: "local" | "crm";
  displayName?: string;
  phone?: string;
  email?: string;
  channel?: string;
}

export interface AudienceResolveResult {
  recipients: ResolvedRecipient[];
  total: number;
  /** Truncated for /preview (first 50 by default). */
  truncated: boolean;
  /** Plain-English description of how the resolver interpreted the audience. */
  reasoning: string[];
}

// ─── Resolver ──────────────────────────────────────────────

/**
 * Returns the resolved recipient list for an audience definition. Pass
 * `previewLimit` (default 50) to cap the array; the `total` field always
 * reflects the full match count.
 */
export async function resolveAudience(
  tenantId: string,
  audience: AudienceDefinition,
  opts: { previewLimit?: number } = {},
): Promise<AudienceResolveResult> {
  const limit = Math.max(1, Math.min(opts.previewLimit ?? 50, 1000));
  const reasoning: string[] = [];

  if (audience.type === "manual") {
    return resolveManual(tenantId, audience.contactIds ?? [], audience.crmContacts ?? [], limit, reasoning);
  }

  if (audience.type === "saved") {
    reasoning.push(`saved audience (${audience.audienceId}) — saved-audiences table not yet implemented`);
    return { recipients: [], total: 0, truncated: false, reasoning };
  }

  if (audience.type === "filter") {
    return resolveFilter(tenantId, audience.rules, limit, reasoning, audience.module);
  }

  // composite — union of chips + rules + (optional) everyone
  return resolveComposite(tenantId, audience, limit, reasoning);
}

/**
 * Preview wrapper — same as resolveAudience but always limits to 50 and
 * is the canonical entry point the UI should call before letting the
 * operator press "Send".
 */
export async function previewAudience(
  tenantId: string,
  audience: AudienceDefinition,
): Promise<AudienceResolveResult> {
  return resolveAudience(tenantId, audience, { previewLimit: 50 });
}

// ─── Internal: per-type resolvers ───────────────────────────

async function resolveManual(
  tenantId: string,
  contactIds: string[],
  crmContacts: CrmPickedContact[],
  limit: number,
  reasoning: string[],
): Promise<AudienceResolveResult> {
  const haveLocal = contactIds && contactIds.length > 0;
  const haveCrm = crmContacts && crmContacts.length > 0;
  if (!haveLocal && !haveCrm) {
    return { recipients: [], total: 0, truncated: false, reasoning: [...reasoning, "empty manual list"] };
  }

  let localRows: any[] = [];
  let localCount = 0;
  if (haveLocal) {
    [localRows, localCount] = await Promise.all([
      prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, take: limit }),
      prisma.contact.count({ where: { tenantId, id: { in: contactIds } } }),
    ]);
    reasoning.push(`manual list: ${contactIds.length} local ids requested, ${localCount} found`);
  }

  // CRM picks come with their identity fields snapshotted on the audience
  // definition, so we don't re-hit the CRM at fan-out. The send worker
  // synthesizes a recipient from phone/email and leaves contactId null.
  const crmRecipients: ResolvedRecipient[] = haveCrm
    ? crmContacts
        .filter((c) => c.phone || c.email)
        .map((c) => ({
          id: `crm:${c.id}`,
          crmRecordId: c.id,
          source: "crm" as const,
          displayName: c.displayName,
          phone: c.phone,
          email: c.email,
          // No `raw`: chip picks are snapshot-only. Per-recipient
          // template var resolution falls back to displayName/phone/email
          // for chip-only recipients; CRM-only fields render empty.
        }))
    : [];
  if (haveCrm) {
    reasoning.push(`manual list: ${crmContacts.length} CRM picks (${crmRecipients.length} sendable)`);
  }

  const recipients = [...localRows.map(toRecipient), ...crmRecipients].slice(0, limit);
  const total = localCount + crmRecipients.length;
  return { recipients, total, truncated: total > limit, reasoning };
}

async function resolveFilter(
  tenantId: string,
  rules: AudienceFilterGroup,
  limit: number,
  reasoning: string[],
  module?: AudienceModule,
): Promise<AudienceResolveResult> {
  const filters = rules.all ?? rules.any ?? [];

  // Partition rules by where they can be evaluated.
  //   - localRules:  rule.field exists on Contact (LOCAL_FIELD_MAP).
  //   - crmRules:    rule.field is CRM-side (Lead_Source, Stage, custom).
  //   - identityRules: rule.field is name/phone/email/company — these can
  //                    be evaluated *both* locally and via CRM identity
  //                    fan-out, so they belong to local AND drive CRM
  //                    identity lookup.
  const localRules = filters.filter((f) => LOCAL_FIELD_MAP[f.field]);
  const crmOnlyRules = filters.filter(
    (f) => !LOCAL_FIELD_MAP[f.field] && !CRM_IDENTITY_FIELDS.has(f.field),
  );

  // Local-side: only evaluate when there are local-applicable rules.
  // The previous implementation fell through to `{tenantId}` (matching
  // every contact in the tenant) when no clauses applied — that was the
  // root cause of "Lead_Source = website" reporting the entire DB.
  let localRows: any[] = [];
  let localCount = 0;
  if (localRules.length > 0) {
    const where = buildLocalContactWhere(tenantId, { all: localRules }, reasoning);
    [localRows, localCount] = await Promise.all([
      prisma.contact.findMany({ where, take: limit, orderBy: { lastSeenAt: "desc" } }),
      prisma.contact.count({ where }),
    ]);
    reasoning.unshift(`local contacts: ${localCount} match local rules`);
  }

  // CRM-side: union of identity fan-out (existing) and provider-criteria
  // fan-out for non-identity rules (new).
  const crmRows = await fanOutToCrm(tenantId, { all: filters }, reasoning, module);

  // Decision: how do we combine local and CRM matches?
  //
  //   - No local rules, has CRM rules → CRM-only segment. Recipients
  //     are exactly the CRM matches. Local rows are not the source of
  //     truth for CRM-only fields, so we must not fall back to "all
  //     contacts".
  //   - Has local rules, no CRM rules → existing behavior: local
  //     matches plus identity fan-out for fresh CRM rows.
  //   - Has both → intersection: a person must satisfy local rules AND
  //     appear in the CRM match set. Plus CRM-only rows that don't
  //     have a local twin.
  let recipients: ResolvedRecipient[];
  let total: number;

  if (localRules.length === 0 && crmOnlyRules.length === 0) {
    // No usable rules at all — empty audience.
    return {
      recipients: [],
      total: 0,
      truncated: false,
      reasoning: [...reasoning, "no usable rules"],
    };
  }

  if (localRules.length === 0 && crmOnlyRules.length > 0) {
    // CRM-only segment.
    const sliced = crmRows.slice(0, limit);
    recipients = sliced.map(crmToRecipient);
    total = crmRows.length;
    reasoning.push(`CRM-only criteria: ${total} matches`);
  } else if (crmOnlyRules.length > 0) {
    // Mixed local + CRM rules → intersect by phone/email.
    const crmKeys = new Set<string>();
    for (const r of crmRows) {
      if (r.phone) crmKeys.add(r.phone.toLowerCase());
      if (r.email) crmKeys.add(r.email.toLowerCase());
    }
    const intersected = localRows.filter(
      (c: any) =>
        (c.phone && crmKeys.has(c.phone.toLowerCase())) ||
        (c.email && crmKeys.has(c.email.toLowerCase())),
    );
    const localKeys = new Set(
      intersected.flatMap((c: any) =>
        [c.phone?.toLowerCase(), c.email?.toLowerCase()].filter(Boolean) as string[],
      ),
    );
    const crmFresh = crmRows.filter(
      (r) =>
        !(r.phone && localKeys.has(r.phone.toLowerCase())) &&
        !(r.email && localKeys.has(r.email.toLowerCase())),
    );
    recipients = [
      ...intersected.map(toRecipient),
      ...crmFresh.map(crmToRecipient),
    ].slice(0, limit);
    total = intersected.length + crmFresh.length;
    reasoning.push(
      `intersected local with CRM criteria: ${intersected.length} matches, +${crmFresh.length} CRM-only`,
    );
  } else {
    // Local-only rules with optional identity fan-out.
    const localKeys = new Set(
      localRows.flatMap((c: any) =>
        [c.phone?.toLowerCase(), c.email?.toLowerCase()].filter(Boolean) as string[],
      ),
    );
    const crmFresh = crmRows.filter(
      (r) =>
        !(r.phone && localKeys.has(r.phone.toLowerCase())) &&
        !(r.email && localKeys.has(r.email.toLowerCase())),
    );
    recipients = [
      ...localRows.map(toRecipient),
      ...crmFresh.map(crmToRecipient),
    ].slice(0, limit);
    total = localCount + crmFresh.length;
    if (crmFresh.length > 0) reasoning.push(`CRM fan-out: +${crmFresh.length} fresh matches`);
  }

  return { recipients, total, truncated: total > limit, reasoning };
}

async function resolveComposite(
  tenantId: string,
  a: Extract<AudienceDefinition, { type: "composite" }>,
  limit: number,
  reasoning: string[],
): Promise<AudienceResolveResult> {
  const buckets: ResolvedRecipient[][] = [];
  let total = 0;

  // Everyone (bounded by channel if provided)
  if (a.everyone) {
    const where: Record<string, unknown> = { tenantId };
    if (a.channel) where.channel = a.channel;
    const [rows, count] = await Promise.all([
      prisma.contact.findMany({ where, take: limit, orderBy: { lastSeenAt: "desc" } }),
      prisma.contact.count({ where }),
    ]);
    reasoning.push(`everyone${a.channel ? ` on ${a.channel}` : ""}: ${count} contacts`);
    buckets.push(rows.map(toRecipient));
    total += count;
  }

  // Hand-picked chips (local Contacts + CRM picks)
  if ((a.contactIds && a.contactIds.length > 0) || (a.crmContacts && a.crmContacts.length > 0)) {
    const sub = await resolveManual(tenantId, a.contactIds ?? [], a.crmContacts ?? [], limit, reasoning);
    buckets.push(sub.recipients);
    total += sub.total;
  }

  // Rule-based segment
  if (a.rules && (a.rules.all?.length || a.rules.any?.length)) {
    const sub = await resolveFilter(tenantId, a.rules, limit, reasoning, a.module);
    buckets.push(sub.recipients);
    total += sub.total;
  }

  // Dedupe by id, then by phone/email so a chip and a rule-match for the
  // same person don't double-count.
  const seenIds = new Set<string>();
  const seenPhone = new Set<string>();
  const seenEmail = new Set<string>();
  const merged: ResolvedRecipient[] = [];
  for (const bucket of buckets) {
    for (const r of bucket) {
      if (seenIds.has(r.id)) continue;
      const phoneKey = r.phone?.toLowerCase();
      const emailKey = r.email?.toLowerCase();
      if (phoneKey && seenPhone.has(phoneKey)) continue;
      if (emailKey && seenEmail.has(emailKey)) continue;
      seenIds.add(r.id);
      if (phoneKey) seenPhone.add(phoneKey);
      if (emailKey) seenEmail.add(emailKey);
      merged.push(r);
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }

  // Total can over-count when buckets overlap heavily; that's acceptable
  // for a preview. The send worker's final fan-out will dedupe again.
  if (
    merged.length === 0 &&
    total === 0 &&
    !a.everyone &&
    !a.contactIds?.length &&
    !a.crmContacts?.length &&
    !a.rules
  ) {
    reasoning.push("empty composite audience — no chips, rules, or everyone flag");
  }

  return {
    recipients: merged,
    total: Math.max(merged.length, total),
    truncated: total > limit,
    reasoning,
  };
}

// ─── Internal: shared helpers ───────────────────────────────

function toRecipient(c: any): ResolvedRecipient {
  return {
    id: c.id,
    source: "local",
    displayName: c.displayName ?? undefined,
    phone: c.phone ?? undefined,
    email: c.email ?? undefined,
    channel: c.channel ?? undefined,
  };
}

function crmToRecipient(r: CrmRecord): ResolvedRecipient {
  return {
    id: `crm:${r.id}`,
    crmRecordId: r.id,
    source: "crm",
    displayName: r.name,
    phone: r.phone,
    email: r.email,
    raw: (r as any).raw && typeof (r as any).raw === "object"
      ? ((r as any).raw as Record<string, unknown>)
      : undefined,
  };
}

/** Local fields the resolver knows how to translate to a Prisma where. */
const LOCAL_FIELD_MAP: Record<string, string> = {
  name: "displayName",
  displayName: "displayName",
  phone: "phone",
  email: "email",
  channel: "channel",
  externalId: "externalId",
  source: "source",
  tags: "tags",
  createdAt: "createdAt",
  lastSeenAt: "lastSeenAt",
  lastInteractionAt: "lastInteractionAt",
};

/** Identity fields we can fan out to the connected CRM. */
const CRM_IDENTITY_FIELDS = new Set(["name", "displayName", "phone", "email", "company"]);

/**
 * Translate a filter group into a Prisma `where` for the local Contact
 * model. Fields the local Contact doesn't carry (CRM-only fields like
 * `lifecycle_stage`, `industry`) emit a reasoning note and are skipped
 * locally — fan-out picks them up when the field is one of the basic
 * identity fields.
 */
function buildLocalContactWhere(
  tenantId: string,
  rules: AudienceFilterGroup,
  reasoning: string[],
): Record<string, unknown> {
  const filters = rules.all ?? rules.any ?? [];
  const op: "AND" | "OR" = rules.any ? "OR" : "AND";

  const clauses: Array<Record<string, unknown>> = [];
  for (const f of filters) {
    const localField = LOCAL_FIELD_MAP[f.field];
    if (!localField) {
      if (!CRM_IDENTITY_FIELDS.has(f.field)) {
        reasoning.push(`field "${f.field}" not on local Contact and not fanned out — only CRM-side filtering would apply`);
      }
      continue;
    }
    const clause = filterToPrismaClause(localField, f.op, f.value);
    if (clause) clauses.push(clause);
  }
  if (clauses.length === 0) return { tenantId };
  return { tenantId, [op]: clauses } as Record<string, unknown>;
}

function filterToPrismaClause(field: string, op: FilterOp, value: unknown): Record<string, unknown> | null {
  switch (op) {
    case "equals":      return { [field]: { equals: value } };
    case "not_equals":  return { [field]: { not: value } };
    case "contains":    return { [field]: { contains: String(value), mode: "insensitive" } };
    case "starts_with": return { [field]: { startsWith: String(value), mode: "insensitive" } };
    case "ends_with":   return { [field]: { endsWith: String(value), mode: "insensitive" } };
    case "gt":          return { [field]: { gt: value } };
    case "gte":         return { [field]: { gte: value } };
    case "lt":          return { [field]: { lt: value } };
    case "lte":         return { [field]: { lte: value } };
    case "in":          return Array.isArray(value) ? { [field]: { in: value } } : null;
    case "not_in":      return Array.isArray(value) ? { [field]: { notIn: value } } : null;
    case "exists":      return { [field]: { not: null } };
    case "not_exists":  return { [field]: { equals: null } };
    case "in_last_days": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;
      const cutoff = new Date(Date.now() - n * 86400_000);
      return { [field]: { gte: cutoff } };
    }
    case "before":      return { [field]: { lt: new Date(String(value)) } };
    case "after":       return { [field]: { gt: new Date(String(value)) } };
    default:            return null;
  }
}

/**
 * CRM fan-out — delegates to the shared client's `searchByRules`, which
 * dispatches per-provider:
 *   - Zoho:       criteria string → /Leads/search & /Contacts/search
 *   - HubSpot:    filterGroups    → /objects/{leads,contacts}/search
 *   - Salesforce: SOQL WHERE      → /query
 *   - Monday:     column rules    → items_page_by_column_values on the
 *                 operator-configured leads/contacts boards
 *
 * Returns the deduplicated union; surfaces unsupported operators in
 * `reasoning` so the operator can see why a rule didn't narrow the count.
 */
async function fanOutToCrm(
  tenantId: string,
  rules: AudienceFilterGroup,
  reasoning: string[],
  module?: AudienceModule,
): Promise<CrmRecord[]> {
  const filters = rules.all ?? rules.any ?? [];
  if (filters.length === 0) return [];
  const conn = await getConnectedCrm(tenantId);
  if (!conn) return [];

  // Identity hints from rules on phone/email/name/company. The shared
  // client folds these into the provider-specific search.
  const identity: CrmLookupArgs = {};
  for (const f of filters) {
    if (!CRM_IDENTITY_FIELDS.has(f.field)) continue;
    if (f.op !== "equals" && f.op !== "contains" && f.op !== "starts_with") continue;
    const v = typeof f.value === "string" ? f.value : f.value == null ? "" : String(f.value);
    if (!v) continue;
    if (f.field === "phone") identity.phone = v;
    else if (f.field === "email") identity.email = v;
    else if (f.field === "company") identity.company = v;
    else identity.name = v;
  }

  // Non-identity rules + non-local rules are translated by the shared
  // client. Local-only rules (channel/tags/lastSeenAt) stay local; we
  // skip them here because they can't be evaluated CRM-side.
  const crmRules: CrmFilterRule[] = filters
    .filter((f) => !LOCAL_FIELD_MAP[f.field] && !CRM_IDENTITY_FIELDS.has(f.field))
    .map((f) => ({ field: f.field, op: f.op, value: f.value }));

  if (Object.keys(identity).length === 0 && crmRules.length === 0) return [];

  try {
    const result = await searchByRules(tenantId, identity, crmRules, undefined, module);
    if (result.skipped.length > 0) {
      reasoning.push(
        `CRM operator(s) not translatable for ${conn.name}: ${result.skipped
          .map((r) => `${r.field}/${r.op}`)
          .join(", ")}`,
      );
    }
    if (result.rows.length > 0) {
      reasoning.push(`CRM (${conn.name}): ${result.rows.length} matches`);
    }
    return result.rows;
  } catch (err: any) {
    reasoning.push(`CRM fan-out failed: ${err?.message ?? String(err)}`);
    return [];
  }
}

// Re-export the CRM helpers so callers don't need to import twice.
export { getConnectedCrm, crmSearchContacts, crmSearchLeads };
