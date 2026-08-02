/**
 * CRM identity resolution.
 *
 * Source of truth for "who is this person" is the CRM. This module owns the
 * 0 / 1 / 2+ reconciliation flow used by every inbound path:
 *
 *   0 matches  → create a new lead (when mode = create_if_missing) or return
 *                 `not_found` (mode = search_only).
 *   1 match    → ENRICH the existing record with any missing strong identifiers
 *                 (phone, email, PSID, IGSID, username).
 *   2+ matches → if a strong merge signal is present AND the vendor supports
 *                 merge, auto-merge the duplicates into the canonical row.
 *                 Otherwise surface `needs_approval` with the candidate list
 *                 so an operator resolves the conflict (CLAUDE.md rule #9 -
 *                 destructive/irreversible CRM actions stay approval-gated).
 *
 * Normalization is applied on BOTH the read path (before passing identifiers
 * to adapter.findCustomer / findByCustomField) and the write path (before
 * adapter.createLead / enrichContact emit payloads to the vendor). Phone is
 * coerced to E.164; email is lowercased and trimmed.
 *
 * Channel-strong identifiers (Facebook PSID, Instagram IGSID, Instagram
 * @username, etc.) are stored as vendor custom fields per
 * {@link CHANNEL_FIELD_PLAN}. Searching by these fields is best-effort: it
 * relies on the tenant having defined the custom property in their CRM. When
 * absent, the lookup silently returns no matches and the flow falls back to
 * phone/email.
 */

import type {
  CRMAdapter,
  CanonicalCrmContact,
} from "./crm-adapter.types";

// ─── Normalization ──────────────────────────────────────────

/** Lowercase + trim. Returns null if the input doesn't look like an email. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

/**
 * Best-effort E.164. Strips spaces/dashes/parens; falls back to a region
 * country-code prefix when the number is in local format (starts with `0` or
 * is bare digits without a `+`). Library-free on purpose - for hard cases
 * tenants can wire libphonenumber-js later, but the common cases (already
 * E.164, `+972 50 123-4567`, `(212) 555-1234`, `0501234567` with region IL)
 * resolve correctly here.
 */
export function normalizePhone(raw: string | null | undefined, defaultRegion?: string): string | null {
  if (!raw) return null;
  let v = String(raw).replace(/[^\d+]/g, "");
  if (!v) return null;
  if (v.startsWith("+")) {
    return /^\+\d{7,15}$/.test(v) ? v : null;
  }
  const cc = REGION_CC[(defaultRegion || "").toUpperCase()] || null;
  if (cc) {
    if (v.startsWith("0")) v = v.slice(1);
    if (v.startsWith(cc)) v = v.slice(cc.length);
    v = `+${cc}${v}`;
    return /^\+\d{7,15}$/.test(v) ? v : null;
  }
  if (/^\d{8,15}$/.test(v)) return `+${v}`;
  return null;
}

const REGION_CC: Record<string, string> = {
  IL: "972", US: "1", GB: "44", DE: "49", FR: "33", IT: "39", ES: "34",
  CA: "1", AU: "61", IN: "91", BR: "55", MX: "52", NL: "31", SE: "46",
  IE: "353", JP: "81", CN: "86", AE: "971", SA: "966", TR: "90", ZA: "27",
};

/**
 * Lax phone coercion for CRM search queries. Unlike {@link normalizePhone}
 * (used for *writes*, where strict E.164 is mandatory), search inputs need to
 * pass through whatever shape the caller asked for so the adapter can hit the
 * CRM as-is. Returns the input trimmed of common separators when it has ≥7
 * digits; otherwise null. Preserves leading `+` and leading `0`.
 */
export function coerceSearchPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().replace(/[\s\-()_.]/g, "");
  if (!v) return null;
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  return v;
}

/**
 * Generate phone variants for CRM lookup. Different tenants store the same
 * number in different shapes:
 *   - E.164 with `+`        (+972501234567)
 *   - Digits-only no `+`    (972501234567)
 *   - National with leading 0 (0501234567)
 *   - National no leading 0 (501234567)
 *   - Local subscriber suffix (last 7-9 digits)
 *
 * We hand the adapter every viable variant so a missing `+` or a CRM that
 * happens to store the national form doesn't make us miss an existing lead.
 * Duplicates and short strings are filtered. The list is small (≤6 items) -
 * the parallel adapter calls remain cheap.
 */
export function phoneVariants(raw: string | null | undefined, defaultRegion?: string): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const rawTrimmed = String(raw).trim();
  if (rawTrimmed) out.add(rawTrimmed);

  // Strip everything except digits and the leading + so we can derive shapes.
  const cleaned = rawTrimmed.replace(/[^\d+]/g, "");
  if (cleaned) out.add(cleaned);

  const e164 = normalizePhone(rawTrimmed, defaultRegion);
  if (e164) {
    out.add(e164);
    const digits = e164.slice(1); // drop leading +
    out.add(digits);

    // Strip the country-code so we can also try the national form.
    const cc = REGION_CC[(defaultRegion || "").toUpperCase()];
    if (cc && digits.startsWith(cc)) {
      const national = digits.slice(cc.length);
      if (national.length >= 7) {
        out.add(national);
        out.add(`0${national}`);
      }
    } else {
      // Unknown region - try every CC length (1-3). Best-effort fallback.
      for (const len of [1, 2, 3]) {
        if (digits.length > len + 6) {
          const national = digits.slice(len);
          out.add(national);
          out.add(`0${national}`);
        }
      }
    }

    // Last 7-9 digits - covers CRMs storing only the subscriber portion.
    for (const n of [9, 8, 7]) {
      if (digits.length >= n) out.add(digits.slice(-n));
    }
  }

  // Discard anything too short to be a phone number.
  return Array.from(out).filter((v) => v.replace(/[^\d]/g, "").length >= 7);
}

// ─── Channel identity model ────────────────────────────────

export type StrongChannel =
  | "whatsapp"
  | "instagram"
  | "messenger"
  | "webchat"
  | "voice"
  | "sms"
  | "email";

/**
 * Strong channel-scoped identifiers that ride along with phone/email when we
 * try to find or enrich a CRM record. PSID/IGSID come from Meta webhooks;
 * `username` ships on Instagram Business Messaging payloads and is stable
 * (unlike PSID which can be reset when app permissions change). `display_name`
 * is the platform's profile-name claim - used for create-time naming only,
 * never for matching.
 */
export interface ChannelIdentity {
  channel: StrongChannel;
  external_id: string;
  username?: string | null;
  display_name?: string | null;
  profile_url?: string | null;
}

export interface IdentityHints {
  email?: string | null;
  phone?: string | null;
  display_name?: string | null;
  /** Channel-scoped strong identifiers (PSID, IGSID, username, …). */
  channels?: ChannelIdentity[];
  /** Region hint used by phone normalization when the number is in local form. */
  default_region?: string;
}

// ─── Custom field plan ─────────────────────────────────────

/**
 * Vendor-neutral custom field names per channel. The CRM tenant is expected to
 * have these defined; auto-provisioning is a Phase 2 concern. When the field
 * is missing in the CRM the search fails closed (no match) and writes silently
 * skip the property - neither blocks the main flow.
 *
 * We intentionally use lower-snake keys; the Salesforce adapter appends `__c`
 * (the Salesforce custom-field suffix) at the adapter boundary.
 */
export const CHANNEL_FIELD_PLAN: Record<StrongChannel, { external_id?: string; username?: string }> = {
  messenger: { external_id: "gotcha_psid_facebook", username: "gotcha_username_facebook" },
  instagram: { external_id: "gotcha_psid_instagram", username: "gotcha_username_instagram" },
  whatsapp:  { external_id: "gotcha_wa_id" },
  webchat:   { external_id: "gotcha_webchat_id" },
  voice:     { external_id: "gotcha_voice_id" },
  sms:       { external_id: "gotcha_sms_id" },
  email:     { external_id: "gotcha_email_id" },
};

// ─── Outcome ───────────────────────────────────────────────

export type LinkOutcome =
  | { status: "created";        contact: CanonicalCrmContact }
  | { status: "linked";         contact: CanonicalCrmContact; was_enriched: boolean }
  | { status: "merged";         contact: CanonicalCrmContact; merged_from: string[]; auto: boolean }
  | { status: "needs_approval"; candidates: CanonicalCrmContact[]; reason: string }
  | { status: "not_found";      reason: string }
  | { status: "error";          reason: string };

export type LinkMode = "search_only" | "create_if_missing";

export interface LinkOrCreateArgs {
  adapter: CRMAdapter;
  hints: IdentityHints;
  mode?: LinkMode;
  /** Used as Lead.Company / source label when creating. */
  inbound_source?: string;
  /**
   * Operator-supplied fields that ride along to createLead when we end up
   * creating - company name, first/last split, etc. These do NOT participate
   * in the find/match flow.
   */
  create_overrides?: {
    company?: string;
    first_name?: string;
    last_name?: string;
  };
  /** Optional auto-merge gate. Default `false` - surfaces merge to operator. */
  allow_auto_merge?: boolean;
}

// ─── Main entry ────────────────────────────────────────────

export async function linkOrCreateCrmContact(args: LinkOrCreateArgs): Promise<LinkOutcome> {
  const { adapter } = args;
  const mode: LinkMode = args.mode ?? "create_if_missing";

  // 1. Normalize identifiers up-front.
  let email = normalizeEmail(args.hints.email);
  let phone = normalizePhone(args.hints.phone, args.hints.default_region);
  let phoneRaw: string | null = args.hints.phone ?? null;
  const channels = (args.hints.channels || []).filter((c) => c?.external_id);

  // For phone-derived channels (WhatsApp/SMS/voice), the external_id IS the
  // user's phone number. Without this fall-through, conversations that came
  // in with ONLY a channel identity (e.g. inbound WhatsApp where the operator
  // never set a phone hint) would never search the CRM's normal Phone field -
  // they'd only probe the channel-specific custom field, which most tenants
  // don't populate. Same logic for the email channel.
  if (!phone) {
    const phoneish = channels.find((c) => c.channel === "whatsapp" || c.channel === "sms" || c.channel === "voice");
    if (phoneish?.external_id) {
      phoneRaw = phoneish.external_id;
      phone = normalizePhone(phoneish.external_id, args.hints.default_region);
    }
  }
  if (!email) {
    const emailish = channels.find((c) => c.channel === "email");
    if (emailish?.external_id) email = normalizeEmail(emailish.external_id);
  }

  if (!email && !phone && channels.length === 0) {
    return { status: "error", reason: "no_identifiers" };
  }

  // 2. Parallel search across every identifier we have. Each lookup is
  //    permitted to fail (vendor down, custom field missing) without
  //    aborting the others. Each probe is logged so an operator can see
  //    exactly why a known contact failed to match (CLAUDE.md rule #5).
  type Probe = { label: string; query: Record<string, string>; promise: Promise<CanonicalCrmContact[]> };
  const probes: Probe[] = [];

  const runProbe = (label: string, query: Record<string, string>, p: Promise<{ ok: boolean; contacts?: CanonicalCrmContact[]; error?: string } | any>): Promise<CanonicalCrmContact[]> =>
    p
      .then((r) => {
        if (r?.ok) {
          const contacts: CanonicalCrmContact[] = r.contacts || [];
          console.log("[crm-identity] probe", JSON.stringify({ label, query, hits: contacts.length, ids: contacts.map((c) => c.id) }));
          return contacts;
        }
        // CRMAdapter failures carry `reason` (CrmAdapterFindResult); only a few
        // legacy shapes carry `error`. Reading `error` alone renders every real
        // vendor fault as `error:null`, which hides 403s/404s behind "no match".
        console.warn("[crm-identity] probe.miss", JSON.stringify({ label, query, reason: r?.reason ?? r?.error ?? "unknown" }));
        return [];
      })
      .catch((err: any) => {
        console.warn("[crm-identity] probe.throw", JSON.stringify({ label, query, error: err?.message ?? String(err) }));
        return [];
      });

  if (email) {
    probes.push({ label: "email", query: { email }, promise: runProbe("email", { email }, adapter.findCustomer({ email })) });
  }
  // Phone lookups: try every plausible variant of the number (with/without +,
  // national form with/without leading 0, last-7..9 digits). CRMs are wildly
  // inconsistent in how they store phones - a single E.164 query produces
  // false negatives, which is what was making known contacts show up as
  // "unmapped" in the chat side panel.
  if (phone || phoneRaw) {
    const variants = phoneVariants(phoneRaw ?? phone, args.hints.default_region);
    for (const v of variants) {
      probes.push({ label: "phone", query: { phone: v }, promise: runProbe("phone", { phone: v }, adapter.findCustomer({ phone: v })) });
    }
  }
  if (adapter.findByCustomField) {
    for (const c of channels) {
      const plan = CHANNEL_FIELD_PLAN[c.channel];
      if (!plan?.external_id || !c.external_id) continue;
      const q = { channel: c.channel, field: plan.external_id, value: c.external_id };
      probes.push({
        label: `channel:${c.channel}`,
        query: q,
        promise: runProbe(`channel:${c.channel}`, q, adapter.findByCustomField({ field: plan.external_id, value: c.external_id })),
      });
    }
  } else if (channels.length > 0) {
    console.warn("[crm-identity] adapter.findByCustomField not implemented - channel identifiers skipped", JSON.stringify({
      vendor: adapter.vendor,
      channels: channels.map((c) => `${c.channel}:${c.external_id}`),
    }));
  }

  console.log("[crm-identity] lookup.start", JSON.stringify({
    vendor: adapter.vendor,
    email: email ?? null,
    phone: phone ?? null,
    phone_raw: phoneRaw,
    channels: channels.map((c) => `${c.channel}:${c.external_id}`),
    probe_count: probes.length,
    probe_labels: probes.map((p) => p.label),
  }));

  const matches = dedupeById((await Promise.all(probes.map((p) => p.promise))).flat());

  console.log("[crm-identity] lookup.done", JSON.stringify({
    vendor: adapter.vendor,
    total_matches: matches.length,
    match_ids: matches.map((m) => m.id),
  }));

  // 3. Branch.
  if (matches.length === 0) {
    if (mode === "search_only") {
      return { status: "not_found", reason: "no_match" };
    }
    return createNew(args, { email, phone, channels });
  }

  if (matches.length === 1) {
    const target = matches[0]!;
    const delta = computeEnrichment(target, { email, phone, channels });
    if (Object.keys(delta).length === 0) {
      return { status: "linked", contact: target, was_enriched: false };
    }
    if (!adapter.enrichContact) {
      return { status: "linked", contact: target, was_enriched: false };
    }
    const r = await adapter.enrichContact({ contact_id: target.id, kind: target.kind, update: delta });
    return { status: "linked", contact: target, was_enriched: r.ok };
  }

  // 4+. Multi-match.
  const strongSignal = hasStrongMergeSignal(matches, { email, phone });
  if (strongSignal && args.allow_auto_merge && adapter.capabilities.merge_supported && adapter.mergeContacts) {
    const primary = pickPrimary(matches);
    const others  = matches.filter((c) => c.id !== primary.id);
    const mr = await adapter.mergeContacts({
      primary_id: primary.id,
      others: others.map((o) => o.id),
      kind: primary.kind,
    });
    if (mr.ok) {
      // Re-fetch so the caller sees the post-merge canonical row.
      const ctx = await adapter.getCustomerContext({ contact_id: primary.id, kind: primary.kind });
      const contact = ctx.ok && ctx.context ? ctx.context.contact : primary;
      return { status: "merged", contact, merged_from: others.map((o) => o.id), auto: true };
    }
    // Merge attempted but failed → fall through to needs_approval.
  }

  return {
    status: "needs_approval",
    candidates: matches,
    reason: strongSignal ? "merge_not_available" : "weak_merge_signal",
  };
}

// ─── Internals ─────────────────────────────────────────────

function dedupeById(rows: CanonicalCrmContact[]): CanonicalCrmContact[] {
  const seen = new Map<string, CanonicalCrmContact>();
  for (const r of rows) if (r?.id && !seen.has(r.id)) seen.set(r.id, r);
  return Array.from(seen.values());
}

/** Diff: what does the existing CRM row lack that we can fill in? */
function computeEnrichment(
  target: CanonicalCrmContact,
  src: { email: string | null; phone: string | null; channels: ChannelIdentity[] },
): { email?: string; phone?: string; custom?: Record<string, string> } {
  const out: { email?: string; phone?: string; custom?: Record<string, string> } = {};
  if (src.email && !target.email) out.email = src.email;
  if (src.phone && !target.phone) out.phone = src.phone;

  const custom: Record<string, string> = {};
  const tcf: Record<string, unknown> = (target.custom_fields ?? {}) as Record<string, unknown>;
  for (const c of src.channels) {
    const plan = CHANNEL_FIELD_PLAN[c.channel];
    if (!plan) continue;
    if (plan.external_id && c.external_id && tcf[plan.external_id] !== c.external_id) {
      custom[plan.external_id] = c.external_id;
    }
    if (plan.username && c.username && tcf[plan.username] !== c.username) {
      custom[plan.username] = c.username;
    }
  }
  if (Object.keys(custom).length) out.custom = custom;
  return out;
}

async function createNew(
  args: LinkOrCreateArgs,
  norm: { email: string | null; phone: string | null; channels: ChannelIdentity[] },
): Promise<LinkOutcome> {
  const channelCustom: Record<string, string> = {};
  for (const c of norm.channels) {
    const plan = CHANNEL_FIELD_PLAN[c.channel];
    if (!plan) continue;
    if (plan.external_id && c.external_id) channelCustom[plan.external_id] = c.external_id;
    if (plan.username && c.username) channelCustom[plan.username] = c.username;
  }
  const result = await args.adapter.createLead({
    email: norm.email ?? undefined,
    phone: norm.phone ?? undefined,
    display_name: args.hints.display_name ?? norm.channels[0]?.display_name ?? undefined,
    first_name: args.create_overrides?.first_name,
    last_name: args.create_overrides?.last_name,
    company: args.create_overrides?.company,
    source: args.inbound_source,
    custom: Object.keys(channelCustom).length ? channelCustom : undefined,
  });
  if (!result.ok || !result.id) {
    return { status: "error", reason: result.reason ?? "create_failed" };
  }
  const ctx = await args.adapter.getCustomerContext({ contact_id: result.id, kind: result.kind }).catch(() => null);
  const contact: CanonicalCrmContact = (ctx?.ok && ctx.context) ? ctx.context.contact : {
    id: result.id,
    kind: result.kind,
    display_name: args.hints.display_name ?? null,
    email: norm.email,
    phone: norm.phone,
    owner_id: null,
    stage: null,
    custom_fields: channelCustom,
    vendor_updated_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),
    vendor: args.adapter.vendor,
  };
  return { status: "created", contact };
}

/**
 * Strong merge signal - only true when the multi-match almost certainly
 * represents the same physical person:
 *   • All rows share the same email, OR
 *   • All rows share the same phone, OR
 *   • Caller gave us BOTH email and phone, one row carries the email and
 *     another carries the phone (the "split identity" case).
 *
 * Phone-only collision (family lines, shared business numbers) does NOT
 * count as a strong signal - those go to operator approval to avoid
 * merging two real people who share a phone.
 */
function hasStrongMergeSignal(
  matches: CanonicalCrmContact[],
  norm: { email: string | null; phone: string | null },
): boolean {
  if (matches.length < 2) return false;
  const emails = matches.map((m) => (m.email || "").toLowerCase()).filter(Boolean);
  const phones = matches.map((m) => (m.phone || "").replace(/[^\d+]/g, "")).filter(Boolean);
  if (emails.length === matches.length && new Set(emails).size === 1) return true;
  if (phones.length === matches.length && new Set(phones).size === 1) return true;
  if (norm.email && norm.phone) {
    const hasEmailMatch = matches.some((m) => (m.email || "").toLowerCase() === norm.email);
    const hasPhoneMatch = matches.some((m) => (m.phone || "").replace(/[^\d+]/g, "") === norm.phone);
    return hasEmailMatch && hasPhoneMatch;
  }
  return false;
}

/**
 * Pick the merge target: most recently updated wins, ties broken by
 * presence of owner_id, then presence of stage.
 */
function pickPrimary(matches: CanonicalCrmContact[]): CanonicalCrmContact {
  return [...matches].sort((a, b) => {
    const at = a.vendor_updated_at ? Date.parse(a.vendor_updated_at) : 0;
    const bt = b.vendor_updated_at ? Date.parse(b.vendor_updated_at) : 0;
    if (at !== bt) return bt - at;
    if (!!a.owner_id !== !!b.owner_id) return a.owner_id ? -1 : 1;
    if (!!a.stage    !== !!b.stage)    return a.stage    ? -1 : 1;
    return 0;
  })[0]!;
}
