/**
 * Side-effect classification + semantic keys + external-ref extraction.
 *
 * Design rule: NO second registry. Tool side-effect metadata is DERIVED from
 * the existing taxonomy:
 *   - `actionCategoriesForTool()` (moved here so it is the single source of
 *     truth; ai-bot.service.ts imports it back) maps built-in + integration_*
 *     + name-patterned tools → ActionCategory.
 *   - A small ActionCategory → OutcomeKind map (enum→enum, not per-tool).
 *   - Visibility is derived per kind.
 * New tools inherit classification automatically via their category/name.
 *
 * Semantic-key STABILITY guarantee (see semanticKey): identical semantic
 * actions always produce the same key regardless of argument ordering, optional
 * fields, casing, or time/phone formatting - via (1) per-kind identity-field
 * selection, (2) per-field normalization, (3) a fixed field order, and (4) a
 * sorted+normalized stable-stringify fallback for unknown tools.
 */

import type { ActionCategory } from "./behavior-strategies";
import type { OutcomeKind, OutcomeVisibility, ExternalRef } from "./turn-outcome-ledger";

/**
 * Reverse-mapping: which ActionCategory does this tool function name implement?
 * MOVED from ai-bot.service.ts (single source of truth). Mirrors the runtime
 * surface-filter logic. Always-keep / read-only tools return read categories or
 * [].
 */
export function actionCategoriesForTool(toolName: string): ActionCategory[] {
  if (!toolName) return [];
  if (toolName === "escalate_to_human") return ["escalate_to_human"];
  if (toolName === "link_customer_identifier") return ["identity_link"];
  if (toolName.startsWith("submit_")) return [];
  if (/(_search|_get|_lookup|_read)$/.test(toolName)) return ["crm_read", "kb_lookup"];
  if (/^integration_create_lead/.test(toolName)) return ["create_lead"];
  if (/^integration_create_contact/.test(toolName)) return ["create_contact"];
  if (/(_note$|add_note)/.test(toolName)) return ["add_note"];
  if (/(tag_|_tag$)/.test(toolName)) return ["tag"];
  if (/(schedule_followup|set_followup)/.test(toolName)) return ["schedule_followup"];
  if (/(book_|schedule_meeting|schedule_demo)/.test(toolName)) return ["schedule_booking"];
  if (/(send_proposal|send_quote|create_proposal)/.test(toolName)) return ["send_proposal"];
  if (/(update_|patch_)/.test(toolName)) return ["update_record"];
  return [];
}

// Enum→enum map. Categories NOT present here are not recorded as committable
// side effects (read-only, close_conversation has its own gate, copilot-only).
const CATEGORY_TO_KIND: Partial<Record<ActionCategory, OutcomeKind>> = {
  schedule_booking: "booking",
  send_proposal: "send",
  schedule_followup: "send",
  create_lead: "create",
  create_contact: "create",
  update_record: "update",
  add_note: "note",
  tag: "tag",
  identity_link: "link",
};

const KIND_VISIBILITY: Record<OutcomeKind, OutcomeVisibility> = {
  booking: "customer_facing",
  send: "customer_facing",
  create: "background",
  update: "background",
  note: "background",
  tag: "background",
  link: "background",
  other: "background",
};

const READONLY_NAME = /(_search|_get|_lookup|_read|_list)$/;
const SEND_NAME = /(^send_|_send$|send_message|send_email|send_whatsapp)/;

export interface SideEffectInfo {
  sideEffect: boolean;
  kind: OutcomeKind;
  visibility: OutcomeVisibility;
  /** noun for create-style keys: "lead" | "contact" | "" */
  noun: string;
}

/** Classify a tool by NAME, deriving from the existing category taxonomy. */
export function classifySideEffect(toolName: string): SideEffectInfo {
  const cats = actionCategoriesForTool(toolName);
  for (const c of cats) {
    const kind = CATEGORY_TO_KIND[c];
    if (kind) {
      const noun = c === "create_lead" ? "lead" : c === "create_contact" ? "contact" : "";
      return { sideEffect: true, kind, visibility: KIND_VISIBILITY[kind], noun };
    }
  }
  // A recognized read-only / non-committable category → not recorded.
  if (cats.length > 0) return { sideEffect: false, kind: "other", visibility: "background", noun: "" };
  // Unknown name (dotted adapter tools, custom.*): derive a safe default.
  // Read-only-by-name or submit_* → not a side effect. Send-by-name → send.
  if (READONLY_NAME.test(toolName) || toolName.startsWith("submit_")) {
    return { sideEffect: false, kind: "other", visibility: "background", noun: "" };
  }
  if (SEND_NAME.test(toolName)) {
    return { sideEffect: true, kind: "send", visibility: "customer_facing", noun: "" };
  }
  // Default: treat as a side effect so nothing slips through unrecorded.
  return { sideEffect: true, kind: "other", visibility: "background", noun: "" };
}

// ── Stability: canonicalizers ───────────────────────────────────────
const s = (v: unknown): string => (v == null ? "" : String(v));
const canonEmail = (v: unknown): string => s(v).trim().toLowerCase();
const canonPhone = (v: unknown): string => s(v).replace(/[^\d+]/g, "");
const canonSlug = (v: unknown): string => s(v).trim().toLowerCase().replace(/\s+/g, "_");
function canonTimeISO(v: unknown): string {
  const raw = s(v).trim();
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw.toLowerCase() : d.toISOString();
}
/** Stable JSON: recursively sorted keys, dropped null/undefined/"" values. */
function stableStringify(value: unknown): string {
  const norm = (v: any): any => {
    if (v == null || v === "") return undefined;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const nv = norm(v[k]);
        if (nv !== undefined) out[k] = nv;
      }
      return out;
    }
    if (typeof v === "string") return v.trim();
    return v;
  };
  return JSON.stringify(norm(value) ?? {});
}
// Short, stable FNV-1a hash. A within-turn dedup key needs determinism, not
// cryptographic strength; collisions are astronomically unlikely for our small
// per-turn arg sets, and a collision would only over-dedup two actions that are
// already identical by their other key fields.
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export interface SemanticKeyCtx {
  /** Resolved contact identity for the conversation (booking attendee / create dedup fallback). */
  contactId?: string;
}

/**
 * Build a STABLE semantic key. Fixed field order per kind; only identity fields
 * participate (cosmetic args like notes/duration/rationale are excluded).
 */
export function semanticKey(
  info: SideEffectInfo,
  args: Record<string, any>,
  ctx?: SemanticKeyCtx,
): string {
  const a = args || {};
  switch (info.kind) {
    case "booking": {
      const mt = canonSlug(a.meeting_type);
      const slot = canonTimeISO(a.requested_at_iso ?? a.requested_at ?? a.start ?? a.start_iso);
      const attendee = canonEmail(a.customer_email ?? a.email) || (ctx?.contactId ?? "");
      return ["booking", mt, slot, attendee].join("|");
    }
    case "create": {
      const id = canonEmail(a.email ?? a.customer_email) || canonPhone(a.phone) || (ctx?.contactId ?? "");
      return ["create", info.noun || "record", id].join("|");
    }
    case "send": {
      const to = canonEmail(a.to ?? a.email ?? a.customer_email) || canonPhone(a.phone ?? a.to) || (ctx?.contactId ?? "");
      const body = hash(s(a.body ?? a.message ?? a.text ?? a.content));
      return ["send", to, body].join("|");
    }
    case "update": {
      const rec = s(a.record_id ?? a.recordId ?? a.id ?? ctx?.contactId);
      return ["update", rec, hash(stableStringify(a.fields ?? a.updates ?? a))].join("|");
    }
    case "note": {
      const rec = s(a.record_id ?? a.recordId ?? a.id ?? ctx?.contactId);
      return ["note", rec, hash(s(a.note ?? a.text ?? a.body))].join("|");
    }
    case "tag": {
      const rec = s(a.record_id ?? a.recordId ?? a.id ?? ctx?.contactId);
      return ["tag", rec, hash(stableStringify(a.tags ?? a.tag))].join("|");
    }
    case "link": {
      return ["link", canonEmail(a.value ?? a.email) || canonPhone(a.value ?? a.phone) || s(a.value)].join("|");
    }
    default:
      return [info.kind, hash(stableStringify(a))].join("|");
  }
}

// ── externalRef extraction (mandatory for COMMITTED) ────────────────
// Per-kind preferred id keys, with a migration fallback over the id-ish keys
// our handlers already return (eventId / leadId / contactId / id / messageId).
const REF_KEYS_BY_KIND: Record<OutcomeKind, string[]> = {
  booking: ["eventId", "event_id"],
  create: ["leadId", "contactId", "recordId", "lead_id", "contact_id", "record_id", "id", "externalId"],
  send: ["messageId", "message_id", "id"],
  update: ["recordId", "record_id", "id"],
  note: ["noteId", "note_id", "id"],
  tag: ["recordId", "record_id", "id"],
  link: ["contactId", "personId", "id"],
  other: ["id", "externalId", "ref"],
};

const REF_TYPE_BY_KIND: Record<OutcomeKind, string> = {
  booking: "gcal_event",
  create: "crm_record",
  send: "message",
  update: "crm_record",
  note: "crm_note",
  tag: "crm_record",
  link: "contact",
  other: "ref",
};

/** Extract a real external identifier from a handler result. Prefers an explicit
 * `externalRef`, else falls back to known id keys (top-level + nested result/data). */
export function extractExternalRef(kind: OutcomeKind, result: any): ExternalRef | undefined {
  if (!result || typeof result !== "object") return undefined;
  // `output` was missing, and it is the envelope EVERY integration tool comes
  // back in: tool-execution.service wraps an adapter result as
  // `{ ok, output, error }`. So no adapter tool has ever produced a real
  // external ref, every one of them logged a LEDGER_GAP, and each was recorded
  // as `succeeded_unverified` - deduped but "not confidently claimable".
  //
  // Live (2026-08-02): `add_order_note` wrote the note, Shopify showed it, and
  // the bot told the customer it had failed. The ledger said the write could
  // not be claimed and the model believed it - the exact inverse of the lie
  // this whole round is about, produced by the machinery built to prevent it.
  //
  // The explicit branch used to search FEWER places than the key fallback
  // below - it looked at the top level and at `parsed`, while the fallback
  // also walked `result` and `data`. So a handler that did exactly what the
  // LEDGER_GAP warning asked for, and returned an explicit `externalRef`, was
  // still missed, because the ref sat one level down inside the envelope. Both
  // now search the same scopes, which is the only defensible arrangement.
  const scopes = [result, result.output, result.result, result.data, result.parsed, result.parsed?.result];
  for (const scope of scopes) {
    const explicit = scope?.externalRef;
    if (explicit?.id) return { type: String(explicit.type ?? REF_TYPE_BY_KIND[kind]), id: String(explicit.id) };
  }
  for (const key of REF_KEYS_BY_KIND[kind]) {
    for (const scope of scopes) {
      const v = scope?.[key];
      if (v != null && String(v).length > 0) return { type: REF_TYPE_BY_KIND[kind], id: String(v) };
    }
  }
  return undefined;
}
