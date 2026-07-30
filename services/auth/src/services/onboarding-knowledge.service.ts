/**
 * Applies the onboarding → Knowledge Base projection.
 *
 * The projection itself (what SHOULD exist, and how a re-scan reconciles
 * against what DOES exist) is a pure module in `@chatcenter/shared`. This file
 * is the side-effecting half: it reads the tenant's current documents, asks
 * the reconciler for a plan, and executes that plan against services/ai - the
 * only service permitted to embed - forwarding the caller's own JWT so every
 * write goes through the same authentication and tenant resolution as a
 * human-initiated upload. There is no service-to-service back door here.
 *
 * The report it returns is the honest outcome, per document. A failed
 * ingestion is reported as `failed`, never folded into `added`: the whole
 * point of this work is that a customer stops seeing "Learned" for knowledge
 * the employee never received.
 */

import {
  reconcile,
  type ExistingDoc,
  type ProjectedEntry,
  type ReconcileItem,
} from "@chatcenter/shared";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs?: number,
) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;

export interface SyncReport {
  ok: boolean;
  knowledgeBaseId: string | null;
  added: number;
  updated: number;
  unchanged: number;
  preserved: number;
  removed: number;
  failed: number;
  /** Per-document outcome, for the UI's result summary and the audit record. */
  details: Array<{
    dedupeKey: string;
    title?: string;
    action: ReconcileItem["action"] | "failed";
    documentId?: string;
    reason?: string;
  }>;
}

const EMPTY_REPORT: SyncReport = {
  ok: false, knowledgeBaseId: null,
  added: 0, updated: 0, unchanged: 0, preserved: 0, removed: 0, failed: 0,
  details: [],
};

/**
 * The knowledge base onboarding writes into. Created once, then reused.
 *
 * Named in the tenant's own language: this row is customer-facing, and a
 * Hebrew workspace opening Knowledge to find an English "Company Knowledge"
 * described in English is the same half-translated experience as a Hebrew
 * title over an English body.
 */
const KB_NAMES = {
  en: {
    name: "Company Knowledge",
    description: "Built from your website scan and the answers you gave during setup",
  },
  he: {
    name: "ידע החברה",
    description: "נבנה מסריקת האתר ומהתשובות שמסרתם בהגדרה",
  },
};

export async function ensureOnboardingKnowledgeBase(
  prisma: any,
  tenantId: string,
): Promise<string | null> {
  const existing = await prisma.knowledgeBase
    .findFirst({ where: { tenantId }, select: { id: true }, orderBy: { createdAt: "asc" } })
    .catch(() => null);
  if (existing) return existing.id;

  const tenant = await prisma.tenant
    .findUnique({ where: { id: tenantId }, select: { defaultLocale: true } })
    .catch(() => null);
  const copy = String(tenant?.defaultLocale || "en").toLowerCase().startsWith("he")
    ? KB_NAMES.he
    : KB_NAMES.en;

  const created = await prisma.knowledgeBase
    .create({
      data: { tenantId, name: copy.name, description: copy.description },
      select: { id: true },
    })
    .catch(() => null);
  return created?.id ?? null;
}

/**
 * Execute a projection against the tenant's knowledge base.
 *
 * `removeMissing` is passed straight through to the reconciler and should only
 * be set by the website re-scan, scoped to `url` entries - see the reconciler
 * for why a failed synthesis step must never be allowed to delete good topic
 * summaries.
 */
export async function applyProjection(
  deps: {
    prisma: any;
    fetchFn: FetchLike;
    authHeader: string;
  },
  tenantId: string,
  projected: ProjectedEntry[],
  options: { removeMissing?: boolean; removeScope?: ExistingDoc extends never ? never : any[] } = {},
): Promise<SyncReport> {
  const { prisma, fetchFn, authHeader } = deps;

  const kbId = await ensureOnboardingKnowledgeBase(prisma, tenantId);
  if (!kbId) return { ...EMPTY_REPORT, details: [{ dedupeKey: "-", action: "failed", reason: "no_knowledge_base" }] };

  // Read the current state directly (this service owns no knowledge logic - it
  // only needs the metadata to reconcile, and reading is tenant-scoped).
  const existing: ExistingDoc[] = await prisma.knowledgeDocument
    .findMany({
      where: { tenantId, knowledgeBaseId: kbId },
      select: { id: true, title: true, metadata: true, status: true },
    })
    .catch(() => []);

  const plan = reconcile(projected, existing, options as any);

  const report: SyncReport = {
    ...EMPTY_REPORT,
    ok: true,
    knowledgeBaseId: kbId,
    details: [],
  };

  for (const item of plan.items) {
    try {
      if (item.action === "create") {
        const id = await createDoc(fetchFn, authHeader, kbId, item.entry!);
        if (id) {
          report.added += 1;
          report.details.push({ dedupeKey: item.dedupeKey, title: item.entry!.title, action: "create", documentId: id });
        } else {
          report.failed += 1;
          report.details.push({ dedupeKey: item.dedupeKey, title: item.entry!.title, action: "failed", reason: "ingest_failed" });
        }
      } else if (item.action === "update") {
        const ok = await updateDoc(fetchFn, authHeader, kbId, item.existingId!, item.entry!);
        if (ok) {
          report.updated += 1;
          report.details.push({ dedupeKey: item.dedupeKey, title: item.entry!.title, action: "update", documentId: item.existingId, reason: item.reason });
        } else {
          report.failed += 1;
          report.details.push({ dedupeKey: item.dedupeKey, title: item.entry!.title, action: "failed", reason: "update_failed" });
        }
      } else if (item.action === "remove") {
        const ok = await deleteDoc(fetchFn, authHeader, kbId, item.existingId!);
        if (ok) {
          report.removed += 1;
          report.details.push({ dedupeKey: item.dedupeKey, action: "remove", documentId: item.existingId, reason: item.reason });
        } else {
          report.failed += 1;
          report.details.push({ dedupeKey: item.dedupeKey, action: "failed", reason: "delete_failed" });
        }
      } else if (item.action === "unchanged") {
        report.unchanged += 1;
        report.details.push({ dedupeKey: item.dedupeKey, title: item.entry?.title, action: "unchanged", documentId: item.existingId });
      } else if (item.action === "preserved") {
        report.preserved += 1;
        report.details.push({ dedupeKey: item.dedupeKey, title: item.entry?.title, action: "preserved", documentId: item.existingId, reason: item.reason });
      }
    } catch (err: any) {
      report.failed += 1;
      report.details.push({ dedupeKey: item.dedupeKey, action: "failed", reason: err?.message || "unknown_error" });
    }
  }

  return report;
}

// ─── services/ai calls ──────────────────────────────────────

async function createDoc(
  fetchFn: FetchLike, authHeader: string, kbId: string, entry: ProjectedEntry,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `${AI_SERVICE_URL}/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          title: entry.title,
          content: entry.content,
          // A projected page carries its text already; sending sourceType
          // "url" here would make services/ai re-fetch the page a second time.
          sourceType: entry.sourceType === "url" ? "url_text" : entry.sourceType,
          sourceUrl: entry.sourceUrl,
          metadata: entry.metadata,
        }),
      },
      30000,
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return (json?.data?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function updateDoc(
  fetchFn: FetchLike, authHeader: string, kbId: string, docId: string, entry: ProjectedEntry,
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `${AI_SERVICE_URL}/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          title: entry.title,
          content: entry.content,
          metadata: entry.metadata,
        }),
      },
      30000,
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteDoc(
  fetchFn: FetchLike, authHeader: string, kbId: string, docId: string,
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `${AI_SERVICE_URL}/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
      { method: "DELETE", headers: { Authorization: authHeader } },
      20000,
    );
    return res.ok;
  } catch {
    return false;
  }
}
