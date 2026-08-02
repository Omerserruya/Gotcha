/**
 * Recommendations - the living AI backlog.
 *
 * Discovery produces a set of suggestions; this service PERSISTS them as
 * Recommendation rows so nothing is ever ephemeral. "I'll do it later" loses
 * nothing. A recommendation lives until it is completed, dismissed, or replaced
 * by a better one. Idempotent via (tenantId, dedupeKey): a re-scan updates the
 * same logical rec, never duplicates, and never resurrects one the customer
 * already completed or dismissed.
 *
 * Onboarding is only the FIRST surface for these; the Home dashboard is next.
 */

import { prisma } from "@chatcenter/shared";

type Confidence = string;

interface DesiredRec {
  dedupeKey: string;
  kind: string;
  title: string;
  reason?: string;
  action?: string;
  targetSlug?: string;
  confidence?: Confidence;
  priority: number;
  payload?: Record<string, unknown>;
}

const ROLE_TITLE: Record<string, string> = {
  customer_support: "Hire a Customer Support AI Employee",
  sales: "Hire a Sales AI Employee",
  reception: "Hire a Reception AI Employee",
  conversation_intelligence: "Turn on Conversation Intelligence",
};

// Systems GOTCHA can actually connect (must match CORE_SYSTEM_SLUGS in
// routes/onboarding.ts and the SYSTEMS catalog in the setup UI). A detected
// tool OUTSIDE this set must never become a "Connect X" recommendation - a
// connect CTA the product can't honor is a broken promise. Those become
// `tool_detected` acknowledgments instead.
const CONNECTABLE_SYSTEMS = new Set(["hubspot", "salesforce", "zoho_crm", "shopify", "fireberry", "airtable"]);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

/** Translate a discovery report into the desired set of recommendations. */
export function buildDesiredRecommendations(report: any): DesiredRec[] {
  const rec = report?.recommendation || {};
  const out: DesiredRec[] = [];

  // 1. The first hire (highest priority - it's the whole point).
  const role = rec.employeeRole || "customer_support";
  out.push({
    dedupeKey: "hire",
    kind: "hire_employee",
    title: rec.employeeName || ROLE_TITLE[role] || ROLE_TITLE.customer_support,
    reason: rec.reason || undefined,
    action: `hire:${role}`,
    targetSlug: role,
    confidence: "likely",
    priority: 100,
  });

  // 2. Connect systems - ALREADY-DETECTED first (act on what we know: Shopify
  //    before proposing new tools). alreadyDetected bumps priority. Only slugs
  //    with a real connector become connect_system; detected-but-unsupported
  //    tools (Yotpo, ReturnGO, …) are acknowledged honestly as tool_detected -
  //    no connect verb, no dead CTA.
  for (const s of Array.isArray(rec.systems) ? rec.systems : []) {
    const slug = String(s?.slug || "").toLowerCase();
    if (!slug) continue;
    const detected = !!s?.alreadyDetected;
    if (CONNECTABLE_SYSTEMS.has(slug)) {
      out.push({
        dedupeKey: `connect:${slug}`,
        kind: "connect_system",
        title: `Connect ${titleCase(slug)}`,
        reason: s?.reason || undefined,
        action: `connect:${slug}`,
        targetSlug: slug,
        confidence: detected ? "confirmed" : "likely",
        priority: detected ? 90 : 70,
        // `evidence` powers the ⓘ "how do I know this" popover - the honest
        // provenance: a code fingerprint found during the scan vs an AI
        // suggestion grounded in the business profile.
        payload: {
          alreadyDetected: detected,
          supported: true,
          evidence: detected ? { source: "site_scan", detail: "code_fingerprint" } : { source: "ai_recommendation" },
        },
      });
    } else {
      out.push({
        dedupeKey: `tool:${slug}`,
        kind: "tool_detected",
        title: `${titleCase(slug)} - noticed on your site`,
        reason: s?.reason || undefined,
        targetSlug: slug,
        confidence: detected ? "confirmed" : "likely",
        priority: detected ? 45 : 30,
        payload: {
          alreadyDetected: detected,
          supported: false,
          evidence: detected ? { source: "site_scan", detail: "code_fingerprint" } : { source: "ai_recommendation" },
        },
      });
    }
  }

  // 3. Connect channels - EVERY detected channel GOTCHA can operate becomes a
  //    rec, so skipping any at the end (Movement 9) loses nothing; each persists
  //    as a living recommendation. The AI-recommended channel ranks highest.
  const PRIMARY_CH = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram", "email", "phone"]);
  const recChannel = typeof rec.channel === "string" ? (rec.channel.toLowerCase().split(/[^a-z]+/)[0] || "") : "";
  const detectedChannels = Array.isArray(report?.communication?.channels) ? report.communication.channels : [];
  const seenCh = new Set<string>();
  for (const c of detectedChannels) {
    const type = String(c?.type || "").toLowerCase();
    if (!PRIMARY_CH.has(type) || seenCh.has(type)) continue;
    seenCh.add(type);
    out.push({
      dedupeKey: `channel:${type}`,
      kind: "connect_channel",
      title: `Connect ${titleCase(type)}`,
      reason: c?.purpose || undefined,
      action: `connect_channel:${type}`,
      targetSlug: type,
      confidence: c?.confidence || "likely",
      priority: type === recChannel ? 65 : 55,
      payload: {
        identifier: (c as any)?.identifier || undefined,
        provider: (c as any)?.provider || undefined,
        evidence: (c as any)?.identifier ? { source: "site_scan", detail: "identifier_found", identifier: (c as any).identifier } : { source: "ai_recommendation" },
      },
    });
  }
  // Persist the recommended channel even if it wasn't among the detected ones.
  if (recChannel && !seenCh.has(recChannel)) {
    out.push({ dedupeKey: `channel:${slugify(recChannel)}`, kind: "connect_channel", title: `Connect ${titleCase(recChannel)}`, action: `connect_channel:${recChannel}`, targetSlug: recChannel, priority: 60 });
  }

  // Live web chat: if the scan found no chat widget on the site, recommend
  // GOTCHA's own embedded web chat - a real, connectable surface. This is the
  // "add live chat" journey mission; skipping it during onboarding loses nothing.
  const hasSiteChat = detectedChannels.some((c: any) => String(c?.type || "").toLowerCase() === "website_chat");
  if (!hasSiteChat) {
    out.push({
      dedupeKey: "channel:webchat",
      kind: "connect_channel",
      title: "Add live chat to your website",
      reason: "No live-chat widget was found on your site - GOTCHA's web chat lets visitors talk to your AI employee right on the page.",
      action: "connect_channel:webchat",
      targetSlug: "webchat",
      confidence: "likely",
      priority: 58,
      payload: { evidence: { source: "site_scan", detail: "absence_after_scan" } },
    });
  }

  // 4. Import knowledge the employee needs.
  for (const k of Array.isArray(rec.knowledge) ? rec.knowledge : []) {
    const label = String(k?.label || "").trim();
    if (!label) continue;
    out.push({
      dedupeKey: `teach:${slugify(label)}`,
      kind: "import_knowledge",
      title: label,
      reason: k?.reason || undefined,
      action: "teach",
      confidence: "likely",
      priority: 50,
    });
  }

  // 5. Honest gaps become teach-me recommendations too.
  for (const g of Array.isArray(report?.gaps) ? report.gaps : []) {
    const label = String(g?.label || "").trim();
    if (!label) continue;
    out.push({
      dedupeKey: `gap:${slugify(label)}`,
      kind: "import_knowledge",
      title: label,
      reason: g?.ask || undefined,
      action: "teach",
      confidence: g?.confidence || "unknown",
      priority: 40,
    });
  }

  // 6. Workflows / automations - the fifth recommendation domain. Grounded in a
  //    real detected signal so it's a genuine suggestion, never generic filler.
  const platformSlug = String(report?.technology?.platform?.slug || "").toLowerCase();
  const STORE_PLATFORMS = new Set(["shopify", "woocommerce", "magento", "bigcommerce", "prestashop", "wix_stores", "ecwid"]);
  if (STORE_PLATFORMS.has(platformSlug)) {
    out.push({
      dedupeKey: "workflow:order_status",
      kind: "setup_workflow",
      title: "Automate “where’s my order?” replies",
      reason: "You’re on a store platform - order-status questions are your most common and most automatable.",
      action: "workflow:order_status",
      confidence: "likely",
      priority: 35,
    });
  }
  if (role === "sales") {
    out.push({
      dedupeKey: "workflow:lead_followup",
      kind: "setup_workflow",
      title: "Auto follow-up with new leads",
      reason: "A sales employee pays off fastest when no new lead goes cold - automate the first follow-up.",
      action: "workflow:lead_followup",
      confidence: "likely",
      priority: 33,
    });
  }

  return out;
}

function titleCase(s: string): string {
  const map: Record<string, string> = { zoho_crm: "Zoho", hubspot: "HubSpot", whatsapp: "WhatsApp", shopify: "Shopify" };
  if (map[s]) return map[s];
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Persist the discovery report's recommendations. Upserts OPEN ones by dedupeKey
 * (never resurrecting completed/dismissed), and marks any OPEN discovery rec no
 * longer recommended as REPLACED. Best-effort; never throws to the caller.
 */
export async function syncDiscoveryRecommendations(tenantId: string, report: any): Promise<void> {
  try {
    const desired = buildDesiredRecommendations(report);
    const desiredKeys = new Set(desired.map((d) => d.dedupeKey));

    const existing = await prisma.recommendation.findMany({
      where: { tenantId, source: "discovery" },
      select: { id: true, dedupeKey: true, status: true },
    });
    const existingByKey = new Map<string, any>(existing.map((e: any) => [e.dedupeKey, e]));

    for (const d of desired) {
      const prev = existingByKey.get(d.dedupeKey);
      // Never resurrect a rec the customer already resolved.
      if (prev && (prev.status === "COMPLETED" || prev.status === "DISMISSED")) continue;
      await prisma.recommendation.upsert({
        where: { tenantId_dedupeKey: { tenantId, dedupeKey: d.dedupeKey } },
        update: {
          kind: d.kind, title: d.title, reason: d.reason, action: d.action, targetSlug: d.targetSlug,
          confidence: d.confidence ?? "likely", priority: d.priority, payload: d.payload ?? undefined,
          status: "OPEN", source: "discovery",
        },
        create: {
          tenantId, source: "discovery", kind: d.kind, title: d.title, reason: d.reason, action: d.action,
          targetSlug: d.targetSlug, confidence: d.confidence ?? "likely", priority: d.priority,
          payload: d.payload ?? undefined, dedupeKey: d.dedupeKey, status: "OPEN",
        },
      });
    }

    // Retire OPEN discovery recs that are no longer recommended (replaced by a
    // better read of the business).
    const stale = existing.filter((e: any) => e.status === "OPEN" && !desiredKeys.has(e.dedupeKey)).map((e: any) => e.id);
    if (stale.length) {
      await prisma.recommendation.updateMany({ where: { id: { in: stale } }, data: { status: "REPLACED" } });
    }
  } catch (err: any) {
    console.warn("[recommendations] sync failed:", err?.message);
  }
}

/**
 * Reconcile connect_system recs against reality: any OPEN "Connect X" whose
 * integration is already CONNECTED is fulfilled - complete it so the list the
 * customer sees never asks for something they already did. Cheap (one query),
 * called on every recommendations read. Best-effort, never throws.
 */
export async function reconcileConnectSystemRecs(tenantId: string): Promise<void> {
  try {
    const open = await prisma.recommendation.findMany({
      where: { tenantId, kind: "connect_system", status: "OPEN", targetSlug: { not: null } },
      select: { id: true, targetSlug: true },
    });
    if (!open.length) return;
    const connected = await prisma.tenantIntegration.findMany({
      where: { tenantId, status: "CONNECTED", integration: { slug: { in: open.map((r: any) => r.targetSlug as string) } } },
      select: { integration: { select: { slug: true } } },
    });
    const connectedSlugs = new Set(connected.map((c: any) => c.integration?.slug).filter(Boolean));
    const fulfilled = open.filter((r: any) => connectedSlugs.has(r.targetSlug)).map((r: any) => r.id);
    if (fulfilled.length) {
      await prisma.recommendation.updateMany({
        where: { id: { in: fulfilled } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }
  } catch (err: any) {
    console.warn("[recommendations] reconcile failed:", err?.message);
  }
}

export async function listRecommendations(tenantId: string, status: string = "OPEN") {
  return prisma.recommendation.findMany({
    where: { tenantId, ...(status === "all" ? {} : { status }) },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

export async function setRecommendationStatus(
  tenantId: string,
  id: string,
  status: "COMPLETED" | "DISMISSED" | "OPEN",
): Promise<{ ok: boolean; previous?: string }> {
  const r = await prisma.recommendation.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
  if (!r) return { ok: false };
  await prisma.recommendation.update({
    where: { id },
    data:
      status === "OPEN"
        // Reopen: clears the resolution stamps so the rec behaves exactly
        // like before it was resolved (sync will not resurrect/duplicate it
        // - it is upserted by dedupeKey).
        ? { status, completedAt: null, dismissedAt: null }
        : { status, ...(status === "COMPLETED" ? { completedAt: new Date() } : { dismissedAt: new Date() }) },
  });
  return { ok: true, previous: r.status };
}

// ─── Second-wave recommendations (source: store_inspection) ──────────────────
// When the owner connects their source-of-truth system, a NEW class of concrete
// next steps becomes possible (I can now look up orders, recognize customers,
// import the catalog). We write these as `source:"store_inspection"` recs so
// they surface post-onboarding on the /business hub - the twin keeps producing
// value as the account matures, not just once during setup. Idempotent and
// never-resurrect, exactly like the discovery recs.
const INSPECT_STORE_SLUGS = new Set(["shopify", "woocommerce", "magento", "bigcommerce", "prestashop", "wix_stores", "ecwid"]);

export async function addStoreInspectionRecs(tenantId: string, slug: string): Promise<void> {
  try {
    const s = (slug || "").toLowerCase();
    if (!s) return;
    const name = titleCase(s);
    const desired: DesiredRec[] = INSPECT_STORE_SLUGS.has(s)
      ? [
          { dedupeKey: `inspect:${s}:orders`, kind: "setup_workflow", title: "Automate “where’s my order?” replies", reason: `${name} is connected - I can look up orders and answer status questions myself.`, action: "workflow:order_status", confidence: "confirmed", priority: 88 },
          { dedupeKey: `inspect:${s}:catalog`, kind: "import_knowledge", title: `Import your ${name} product catalog`, reason: "Teach me your products so I answer questions about them accurately.", action: "import:catalog", confidence: "likely", priority: 60 },
        ]
      : [
          { dedupeKey: `inspect:${s}:recognize`, kind: "setup_workflow", title: `Recognize every customer from ${name}`, reason: `${name} is connected - I can greet returning customers by name and pull their history.`, action: "workflow:recognize_customer", confidence: "confirmed", priority: 86 },
          { dedupeKey: `inspect:${s}:followup`, kind: "setup_workflow", title: "Auto follow-up with new leads", reason: "A connected customer system pays off fastest when no new lead goes cold.", action: "workflow:lead_followup", confidence: "likely", priority: 58 },
        ];

    const existing = await prisma.recommendation.findMany({ where: { tenantId, source: "store_inspection" }, select: { dedupeKey: true, status: true } });
    const byKey = new Map<string, any>(existing.map((e: any) => [e.dedupeKey, e]));
    for (const d of desired) {
      const prev = byKey.get(d.dedupeKey);
      if (prev && (prev.status === "COMPLETED" || prev.status === "DISMISSED")) continue; // never resurrect
      await prisma.recommendation.upsert({
        where: { tenantId_dedupeKey: { tenantId, dedupeKey: d.dedupeKey } },
        update: { kind: d.kind, title: d.title, reason: d.reason, action: d.action, confidence: d.confidence ?? "likely", priority: d.priority, status: "OPEN", source: "store_inspection" },
        create: { tenantId, source: "store_inspection", kind: d.kind, title: d.title, reason: d.reason, action: d.action, confidence: d.confidence ?? "likely", priority: d.priority, dedupeKey: d.dedupeKey, status: "OPEN" },
      });
    }
  } catch (err: any) {
    console.warn("[recommendations] store-inspection failed:", err?.message);
  }
}
