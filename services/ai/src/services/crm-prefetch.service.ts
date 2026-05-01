/**
 * CRM Prefetch — runs at the start of every autonomous bot turn.
 *
 * Calls `lead_search` and `contact_search` against the connected CRM
 * (Zoho today; pattern works for any provider whose catalog tools use
 * those slugs) using the customer's WhatsApp phone and any email
 * extracted from the recent transcript. Returns a structured summary
 * the bot service can:
 *   - render as a `## Existing CRM Records` system-prompt block
 *   - use to STRIP `create_lead` / `create_contact` from the model's
 *     tool surface when a match exists, so duplicate creation is
 *     impossible at the OpenAI tool-calling layer
 *
 * Goes through `executeTool()` (same path the bot's auto-dispatcher
 * uses) so OAuth refresh, auditing, and per-tool execution logging
 * all happen the same way as a regular bot-fired tool call.
 *
 * Best-effort: any failure is swallowed and the function returns null.
 * The bot keeps operating (in the worst case it might create a
 * duplicate) — we never want a transient CRM hiccup to break the chat.
 */

import { prisma } from "@chatcenter/shared";
import { executeTool } from "./tool-execution.service";

export interface CrmRecord {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  createdAt?: string;
  modifiedAt?: string;
  leadSource?: string;
  description?: string;
}

export interface CrmNote {
  id: string;
  title?: string;
  content?: string;
  createdAt?: string;
}

export interface CrmPrefetchResult {
  leadMatches: CrmRecord[];
  contactMatches: CrmRecord[];
  topLeadNotes: CrmNote[];
  topContactNotes: CrmNote[];
  searchedBy: { phone?: string; email?: string };
}

export async function prefetchCrmContext(
  tenantId: string,
  conversationId: string,
  customer: { externalId?: string | null; email?: string | null },
): Promise<CrmPrefetchResult | null> {
  const phone = normalizePhone(customer.externalId ?? undefined);
  const email = (customer.email || "").trim() || undefined;
  if (!phone && !email) return null;

  const result: CrmPrefetchResult = {
    leadMatches: [],
    contactMatches: [],
    topLeadNotes: [],
    topContactNotes: [],
    searchedBy: { phone, email },
  };

  // Resolve the tenant's tool rows once. If neither search tool is
  // enabled for this tenant, prefetch is a no-op.
  const [leadSearchTool, contactSearchTool, getLeadNotesTool, getContactNotesTool] =
    await Promise.all([
      findTenantToolBySlug(tenantId, "lead_search"),
      findTenantToolBySlug(tenantId, "contact_search"),
      findTenantToolBySlug(tenantId, "get_lead_notes"),
      findTenantToolBySlug(tenantId, "get_contact_notes"),
    ]);
  if (!leadSearchTool && !contactSearchTool) return null;

  // ── Lead search ─────────────────────────────────────────────
  if (leadSearchTool) {
    const inputs: Array<Record<string, string>> = [];
    if (phone) inputs.push({ phone });
    if (email) inputs.push({ email });
    for (const input of inputs) {
      try {
        const exec = await executeTool({
          tenantId,
          conversationId,
          tenantToolId: leadSearchTool.id,
          input,
          triggeredBy: "ai",
        });
        const rows = parseZohoSearchRows(exec.output);
        for (const row of rows) {
          if (!result.leadMatches.some((m) => m.id === row.id)) {
            result.leadMatches.push(toRecord(row));
          }
        }
      } catch (err: any) {
        console.warn("[crm-prefetch] lead_search failed:", err?.message);
      }
    }
  }

  // ── Contact search ──────────────────────────────────────────
  if (contactSearchTool) {
    const inputs: Array<Record<string, string>> = [];
    if (phone) inputs.push({ phone });
    if (email) inputs.push({ email });
    for (const input of inputs) {
      try {
        const exec = await executeTool({
          tenantId,
          conversationId,
          tenantToolId: contactSearchTool.id,
          input,
          triggeredBy: "ai",
        });
        const rows = parseZohoSearchRows(exec.output);
        for (const row of rows) {
          if (!result.contactMatches.some((m) => m.id === row.id)) {
            result.contactMatches.push(toRecord(row));
          }
        }
      } catch (err: any) {
        console.warn("[crm-prefetch] contact_search failed:", err?.message);
      }
    }
  }

  // ── Notes for the top match (cheap context for the bot) ─────
  // Only fetch for the single most-recent record per module to keep
  // the prefetch fast (cap at ~4 Zoho calls per turn total).
  if (getLeadNotesTool && result.leadMatches.length > 0) {
    const top = pickMostRecent(result.leadMatches);
    try {
      const exec = await executeTool({
        tenantId,
        conversationId,
        tenantToolId: getLeadNotesTool.id,
        input: { id: top.id },
        triggeredBy: "ai",
      });
      result.topLeadNotes = parseZohoNotes(exec.output);
    } catch (err: any) {
      console.warn("[crm-prefetch] get_lead_notes failed:", err?.message);
    }
  }
  if (getContactNotesTool && result.contactMatches.length > 0) {
    const top = pickMostRecent(result.contactMatches);
    try {
      const exec = await executeTool({
        tenantId,
        conversationId,
        tenantToolId: getContactNotesTool.id,
        input: { id: top.id },
        triggeredBy: "ai",
      });
      result.topContactNotes = parseZohoNotes(exec.output);
    } catch (err: any) {
      console.warn("[crm-prefetch] get_contact_notes failed:", err?.message);
    }
  }

  // Sort matches most-recent-first so the rendered prompt and the
  // "use this id" pick are deterministic.
  result.leadMatches.sort(byCreatedDesc);
  result.contactMatches.sort(byCreatedDesc);
  return result;
}

/**
 * Render the prefetch result as a system-prompt section the bot can
 * consume. Returns empty string if there's nothing to render.
 */
export function renderCrmContextBlock(prefetch: CrmPrefetchResult | null): string {
  if (!prefetch) return "";
  const hasLead = prefetch.leadMatches.length > 0;
  const hasContact = prefetch.contactMatches.length > 0;
  if (!hasLead && !hasContact) return "";

  const sections: string[] = [];
  if (hasLead) {
    const top = prefetch.leadMatches[0];
    const lines: string[] = [];
    lines.push(`### Existing Lead${prefetch.leadMatches.length > 1 ? `s (${prefetch.leadMatches.length} matches)` : ""}`);
    lines.push(`- id: ${top.id}    ← use THIS id when calling update_lead / add_lead_note / add_lead_tag`);
    if (top.name) lines.push(`- name: ${top.name}`);
    if (top.email) lines.push(`- email: ${top.email}`);
    if (top.phone) lines.push(`- phone: ${top.phone}`);
    if (top.leadSource) lines.push(`- lead source: ${top.leadSource}`);
    if (top.createdAt) lines.push(`- created: ${top.createdAt}`);
    if (top.description) lines.push(`- description: ${top.description}`);
    if (prefetch.leadMatches.length > 1) {
      lines.push(`- (${prefetch.leadMatches.length - 1} older lead(s) also match this customer — use the id above)`);
    }
    if (prefetch.topLeadNotes.length > 0) {
      lines.push(`- recent notes:`);
      for (const n of prefetch.topLeadNotes.slice(0, 5)) {
        const head = n.title ? `${n.title}: ` : "";
        const body = (n.content || "").replace(/\s+/g, " ").slice(0, 160);
        lines.push(`  - ${n.createdAt ? `[${n.createdAt}] ` : ""}${head}${body}`);
      }
    }
    sections.push(lines.join("\n"));
  }
  if (hasContact) {
    const top = prefetch.contactMatches[0];
    const lines: string[] = [];
    lines.push(`### Existing Contact${prefetch.contactMatches.length > 1 ? `s (${prefetch.contactMatches.length} matches)` : ""}`);
    lines.push(`- id: ${top.id}    ← use THIS id when calling update_contact / add_contact_note / add_contact_tag`);
    if (top.name) lines.push(`- name: ${top.name}`);
    if (top.email) lines.push(`- email: ${top.email}`);
    if (top.phone) lines.push(`- phone: ${top.phone}`);
    if (top.createdAt) lines.push(`- created: ${top.createdAt}`);
    if (top.description) lines.push(`- description: ${top.description}`);
    if (prefetch.topContactNotes.length > 0) {
      lines.push(`- recent notes:`);
      for (const n of prefetch.topContactNotes.slice(0, 5)) {
        const head = n.title ? `${n.title}: ` : "";
        const body = (n.content || "").replace(/\s+/g, " ").slice(0, 160);
        lines.push(`  - ${n.createdAt ? `[${n.createdAt}] ` : ""}${head}${body}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  const removedTools: string[] = [];
  if (hasLead) removedTools.push("create_lead");
  if (hasContact) removedTools.push("create_contact");
  const removedNote = removedTools.length > 0
    ? `\n\nThe ${removedTools.map((s) => `\`${s}\``).join(" and ")} ${removedTools.length === 1 ? "tool has" : "tools have"} been REMOVED from your toolbox for this turn — the customer already exists in CRM. Use the update / note / tag tools on the id(s) above to enrich the existing record(s). Never tell the customer about CRM internals.`
    : "";

  return `## Existing CRM Records — INTERNAL CONTEXT, NEVER ECHO

EVERYTHING in this section is INTERNAL. The customer must NEVER hear about it.

DO NOT, under any circumstances:
- tell the customer they "already exist" / "are in our system" / "have a record / lead / contact"
- say "I see your lead" / "I'll update your contact" / "I'm checking the CRM"
- mention CRM, leads, contacts, deals, records, ids, notes, tags, the database, the system, or any tool name
- quote any id, email, or phone from this block back at the customer

If you want to acknowledge familiarity, say it the way a human would — "good to hear from you again" — not "I have you on file." Treat the customer as a returning person, not a database row.

${sections.join("\n\n")}${removedNote}`;
}

// ─── helpers ────────────────────────────────────────────────

async function findTenantToolBySlug(tenantId: string, slug: string) {
  try {
    return await prisma.tenantTool.findFirst({
      where: {
        tenantId,
        isEnabled: true,
        tenantIntegration: { status: "CONNECTED" },
        catalogTool: { slug },
      },
      select: { id: true },
    });
  } catch {
    return null;
  }
}

function normalizePhone(externalId: string | undefined): string | undefined {
  if (!externalId) return undefined;
  const trimmed = String(externalId).trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // WhatsApp wa_id is digits-only without "+", e.g. "972525401686".
  if (/^\d{6,}$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

function parseZohoSearchRows(output: unknown): any[] {
  if (!output) return [];
  // Zoho returns 200 with `{ data: [...], info: {...} }` on hit, OR
  // 204 with empty body / null on no-match. tool-execution maps those
  // to `output = null | "" | { data: [...] }`.
  if (typeof output === "object" && output !== null && "data" in (output as any)) {
    const data = (output as any).data;
    return Array.isArray(data) ? data : [];
  }
  return [];
}

function parseZohoNotes(output: unknown): CrmNote[] {
  const rows = parseZohoSearchRows(output);
  return rows.map((r: any) => ({
    id: String(r.id ?? ""),
    title: r.Note_Title || undefined,
    content: r.Note_Content || undefined,
    createdAt: r.Created_Time || undefined,
  }));
}

function toRecord(row: any): CrmRecord {
  return {
    id: String(row.id ?? ""),
    name: row.Full_Name || [row.First_Name, row.Last_Name].filter(Boolean).join(" ").trim() || undefined,
    email: row.Email || undefined,
    phone: row.Phone || row.Mobile || undefined,
    createdAt: row.Created_Time || undefined,
    modifiedAt: row.Modified_Time || undefined,
    leadSource: row.Lead_Source || undefined,
    description: row.Description || undefined,
  };
}

function pickMostRecent<T extends { createdAt?: string }>(rows: T[]): T {
  const sorted = [...rows].sort(byCreatedDesc);
  return sorted[0];
}

function byCreatedDesc<T extends { createdAt?: string }>(a: T, b: T): number {
  const aT = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bT = b.createdAt ? Date.parse(b.createdAt) : 0;
  return bT - aT;
}
