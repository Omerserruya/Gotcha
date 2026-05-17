/**
 * Post-conversation CRM writer — kind-aware (Lead vs Contact).
 *
 * The legacy action-executor `update_contact` only writes to the Contact
 * module. The post-conversation summarizer often needs to write back to a
 * Lead (when the customer hasn't been converted yet). This helper:
 *
 *   1. Resolves the customer's crmContactId + crmObjectKind from the
 *      conversation's Contact.metadata.
 *   2. If both present, calls `CRMAdapter.updateRecord({ kind, id, fields })`
 *      which routes to the right vendor endpoint (Leads vs Contacts).
 *   3. On adapter failure or when the adapter declines kind=contact (e.g.
 *      Salesforce has no update_contact tool), falls back to createNote on
 *      the same record so the structured summary still surfaces in the
 *      vendor UI.
 *
 * The sparse-patch contract from the summarizer is preserved: only keys
 * present in `fields` are written; missing keys leave the existing record
 * untouched.
 */

import { prisma } from "@chatcenter/shared";
import { getCrmAdapter } from "./connectors/crm-adapter-resolver";
import type { CrmObjectKind } from "./connectors/crm-adapter.types";

export interface CrmKindWriteResult {
  ok: boolean;
  /** "update" | "note" | "skipped" */
  outcome: "update" | "note" | "skipped";
  kind: CrmObjectKind | null;
  crmContactId: string | null;
  reason?: string;
  fieldsWritten?: string[];
}

async function resolveCrmIdentity(
  tenantId: string,
  conversationId: string,
): Promise<{ crmContactId: string | null; crmObjectKind: CrmObjectKind | null }> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { channel: true, customerExternalId: true },
  });
  if (!conv) return { crmContactId: null, crmObjectKind: null };
  const contact = await prisma.contact.findFirst({
    where: { tenantId, channel: conv.channel as any, externalId: conv.customerExternalId },
    select: { metadata: true },
  });
  const meta = ((contact?.metadata as any) ?? {}) as Record<string, any>;
  const kind = meta?.crmObjectKind;
  return {
    crmContactId: typeof meta?.crmContactId === "string" ? meta.crmContactId : null,
    crmObjectKind: kind === "lead" || kind === "contact" ? (kind as CrmObjectKind) : null,
  };
}

function sparseFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

function renderPatchAsNote(fields: Record<string, unknown>): string {
  const lines = ["GOTCHA — post-conversation summary update:"];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (typeof v === "string") val = v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v);
    lines.push(`- ${k}: ${val}`);
  }
  return lines.join("\n");
}

/**
 * Apply the sparse CRM patch the summarizer produced. Routes by kind so
 * Leads get updated in Leads and Contacts in Contacts. Falls back to a
 * timeline note when the adapter can't update the kind (Salesforce contact).
 */
export async function applyCrmPatchKindAware(args: {
  tenantId: string;
  conversationId: string;
  fields: Record<string, unknown>;
  /**
   * Optional override — pass a precomputed identity to skip the DB lookup.
   * The voice + chat post-conversation pipelines compute this once and reuse
   * it for both updateRecord and createTask.
   */
  identity?: { crmContactId: string | null; crmObjectKind: CrmObjectKind | null };
  /** Idempotency / dedup key for the note path. */
  sourceInteractionId?: string;
}): Promise<CrmKindWriteResult> {
  const fields = sparseFields(args.fields);
  if (Object.keys(fields).length === 0) {
    return { ok: true, outcome: "skipped", kind: null, crmContactId: null, reason: "no-fields" };
  }

  const identity = args.identity ?? (await resolveCrmIdentity(args.tenantId, args.conversationId));
  if (!identity.crmContactId || !identity.crmObjectKind) {
    return {
      ok: false,
      outcome: "skipped",
      kind: identity.crmObjectKind,
      crmContactId: identity.crmContactId,
      reason: "no-crm-link",
    };
  }

  const adapter = await getCrmAdapter(args.tenantId).catch(() => null);
  if (!adapter || adapter.capabilities.is_stub) {
    return {
      ok: false,
      outcome: "skipped",
      kind: identity.crmObjectKind,
      crmContactId: identity.crmContactId,
      reason: "no-crm-adapter",
    };
  }

  // Try the structured update path first.
  if (adapter.updateRecord) {
    const r = await adapter.updateRecord({
      id: identity.crmContactId,
      kind: identity.crmObjectKind,
      fields,
    });
    if (r.ok) {
      return {
        ok: true,
        outcome: "update",
        kind: identity.crmObjectKind,
        crmContactId: identity.crmContactId,
        fieldsWritten: Object.keys(fields),
      };
    }
    // Fall through to note path on adapter failure.
  }

  // Fallback — write the patch as a timeline note so the structured findings
  // are at least visible in the vendor UI even though we can't patch fields.
  if (!adapter.createNote) {
    return {
      ok: false,
      outcome: "skipped",
      kind: identity.crmObjectKind,
      crmContactId: identity.crmContactId,
      reason: "no-create-note",
    };
  }
  const noteBody = renderPatchAsNote(fields);
  const noteRes = await adapter.createNote({
    contact_id: identity.crmContactId,
    kind: identity.crmObjectKind,
    body: noteBody,
    source_interaction_id: args.sourceInteractionId ?? args.conversationId,
  });
  if (!noteRes.ok) {
    return {
      ok: false,
      outcome: "skipped",
      kind: identity.crmObjectKind,
      crmContactId: identity.crmContactId,
      reason: `note-failed:${noteRes.reason ?? "unknown"}`,
    };
  }
  return {
    ok: true,
    outcome: "note",
    kind: identity.crmObjectKind,
    crmContactId: identity.crmContactId,
    fieldsWritten: Object.keys(fields),
    reason: "patch-written-as-note",
  };
}

export async function getCrmIdentity(
  tenantId: string,
  conversationId: string,
): Promise<{ crmContactId: string | null; crmObjectKind: CrmObjectKind | null }> {
  return resolveCrmIdentity(tenantId, conversationId);
}

export interface CrmKindTaskResult {
  ok: boolean;
  /** "task" | "skipped" */
  outcome: "task" | "skipped";
  kind: CrmObjectKind | null;
  crmContactId: string | null;
  taskId?: string;
  reason?: string;
}

/**
 * Create a vendor-native task on the correct kind (Lead vs Contact) using
 * the adapter's `createTask`. Falls back gracefully when the adapter can't
 * create tasks (returns `skipped`); the caller can decide whether to log a
 * GOTCHA-local VoiceCallActionItem in that case.
 */
export async function createCrmTaskKindAware(args: {
  tenantId: string;
  conversationId: string;
  task: {
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due_at?: string;
  };
  identity?: { crmContactId: string | null; crmObjectKind: CrmObjectKind | null };
  sourceInteractionId?: string;
}): Promise<CrmKindTaskResult> {
  const identity = args.identity ?? (await resolveCrmIdentity(args.tenantId, args.conversationId));
  if (!identity.crmContactId || !identity.crmObjectKind) {
    return { ok: false, outcome: "skipped", kind: identity.crmObjectKind, crmContactId: identity.crmContactId, reason: "no-crm-link" };
  }

  const adapter = await getCrmAdapter(args.tenantId).catch(() => null);
  if (!adapter || adapter.capabilities.is_stub || !adapter.createTask) {
    return { ok: false, outcome: "skipped", kind: identity.crmObjectKind, crmContactId: identity.crmContactId, reason: "no-adapter-task" };
  }

  const r = await adapter.createTask({
    contact_id: identity.crmContactId,
    kind: identity.crmObjectKind,
    subject: args.task.subject,
    body: args.task.body,
    priority: args.task.priority,
    due_at: args.task.due_at,
    source_interaction_id: args.sourceInteractionId ?? args.conversationId,
  });
  if (!r.ok) {
    return { ok: false, outcome: "skipped", kind: identity.crmObjectKind, crmContactId: identity.crmContactId, reason: r.reason };
  }
  return { ok: true, outcome: "task", kind: identity.crmObjectKind, crmContactId: identity.crmContactId, taskId: r.id };
}
