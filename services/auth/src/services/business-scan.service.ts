import crypto from "crypto";
/**
 * "Scan again" - re-read the business's website and update only what the scan
 * owns.
 *
 * Onboarding ran a scan once, at the start, and nothing could run one again.
 * This is the same crawl (`crawlSite`) and the same model call
 * (`/api/ai-assist/discover-business`) driven from the workspace screen, with
 * the provenance rule deciding what may actually be written.
 *
 * ── What it will and will not overwrite ──
 *
 * `planRescan` decides, not this module. A field the scan owns is applied; a
 * field a person edited is OFFERED back with what the scan would have written;
 * a field nobody has ever marked is also only offered, because the profile was
 * seeded by an onboarding confirm step that never distinguished "the scan said
 * this" from "the human accepted it". See field-provenance.service.
 *
 * ── Which fields the scan can speak for ──
 *
 * `business.name`, `business.country`, `business.industry` and
 * `business.summary`. Not `primaryLanguage`: the report's `brand.languages` is
 * free text ("Hebrew"), the column holds an ISO-639-1 code, and inventing the
 * mapping would write a confidently wrong value into a field the AI reads. Not
 * `address` or `currency` either - the scan does not produce them, and a field
 * the scan cannot speak for must never appear in its proposal.
 */
import { prisma, readDurableSetting, writeDurableSetting, normalizeDiscoveryTechnology, projectDiscoveryTopics, projectPages, writeAudit, AuditAction, type SkippedTopic } from "@chatcenter/shared";
import { applyProjection } from "./onboarding-knowledge.service";
import { crawlSite } from "./site-crawl.service";
import {
  readProvenance,
  stampProvenance,
  planRescan,
  type RescanPlan,
} from "./field-provenance.service";

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");

/**
 * The language a scan writes in: the workspace's system language
 * (Tenant.defaultLocale), then what the caller asked for, then English
 * (2026-10-14). A Hebrew workspace's knowledge came out in English because the
 * request carried no locale and the profile's primaryLanguage (the language
 * customers write in) said "en". Used by onboarding's discover and the rescan.
 */
export async function systemLanguage(tenantId: string, requested?: string | null): Promise<"he" | "en"> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }).catch(() => null);
  const pick = (v: unknown) => {
    const s = String(v ?? "").toLowerCase();
    return s.startsWith("he") ? "he" : s.startsWith("en") ? "en" : null;
  };
  return pick(t?.defaultLocale) ?? pick(requested) ?? "en";
}

/**
 * The default transport. `fetchWithTimeout` is route-local in onboarding.ts and
 * already duplicated once elsewhere, so callers may inject theirs rather than
 * a third copy being written here; a caller that has none gets this.
 */
type TimedFetch = (url: string, init: RequestInit, ms: number) => Promise<Response>;
const defaultFetch: TimedFetch = (url, init, ms) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

/**
 * Ask the AI service to turn crawled pages into a report.
 *
 * Exported so `routes/onboarding.ts` and this path use ONE bridge. A second
 * copy would be a second place for the timeout, the shape check or the failure
 * handling to drift, and the two would then disagree about what a failed scan
 * is.
 */
export async function callDiscoverBusiness(
  authHeader: string,
  body: { domain: string; locale: string; pages: Array<{ url: string; text: string }>; signals: unknown; businessType?: string },
  fetchWithTimeoutFn: TimedFetch = defaultFetch,
): Promise<any | null> {
  try {
    const res = await fetchWithTimeoutFn(`${AI_SERVICE_URL}/api/ai-assist/discover-business`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(body),
    }, 60000);
    // Every null says why in the log: a failed scan used to leave no line at all.
    if (!res.ok) {
      const text = await (res as any).text?.().catch(() => "") ?? "";
      console.warn(`[business-scan] discover-business answered ${res.status}: ${String(text).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { data?: { ok?: boolean; report?: any } };
    if (!json?.data?.ok || !json.data.report) {
      console.warn("[business-scan] discover-business returned no report (the model step found nothing usable)");
      return null;
    }
    return json.data.report;
  } catch (err: any) {
    console.warn("[business-scan] discover-business failed:", err?.message);
    return null;
  }
}

/**
 * The profile fields a report can speak for.
 *
 * Empty strings are dropped rather than passed through: the model returning ""
 * means it found nothing, and `planRescan` must see an absent field, not a
 * blank one it might be asked to write.
 */
export function mapReportToProfileFields(report: any): Record<string, unknown> {
  const biz = (report && typeof report === "object" ? report.business : null) ?? {};
  const pick = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : undefined;
  };
  const out: Record<string, unknown> = {};
  const name = pick(biz.name);
  const country = pick(biz.country);
  const industry = pick(biz.industry);
  const summary = pick(biz.summary);
  if (name) out.organizationName = name;
  if (country) out.country = country;
  if (industry) out.industry = industry;
  if (summary) out.businessDescription = summary;
  return out;
}

/**
 * What the crawl could actually see, reported so a screen can be honest about it.
 *
 * ★ `distinctTextPages` IS THE ONE THAT MATTERS. A password-protected store
 * answers 200 to every path, so `pagesRead` can be 17 while the crawl saw one
 * page seventeen times - measured on this deployment's own demo store, where
 * every response was the same 188-byte "This store is password protected".
 *
 * A screen must never say "we read 17 pages" off `pagesRead`. When
 * `distinctTextPages` is 1 the honest sentence is that the site could not be
 * read, and the classification that comes back with it - "ecommerce", from
 * Shopify markers in the login page's own markup - is a confident answer about
 * a site nobody saw.
 *
 * `coverage` is the URLs that answered, which is also what the model is given
 * as the bound on asserting absence ("only assert absence within these").
 */
export interface CrawlReach {
  /** URLs requested, including the home page. */
  requested: number;
  /** URLs that answered with HTML. */
  pagesRead: number;
  /** How many of those carried DISTINCT text. 1 means the site was not readable. */
  distinctTextPages: number;
  coverage: string[];
}

/**
 * Record what the crawl could see on the tenant's discovery row.
 *
 * `updateMany` rather than `update`: a tenant may have no BusinessDiscovery row
 * yet (a rescan can run before onboarding's scan ever did), and a missing row is
 * not a reason to fail a scan. Never throws for the same reason.
 */
export async function persistCrawlReach(tenantId: string, reach: CrawlReach): Promise<void> {
  try {
    await prisma.businessDiscovery.updateMany({
      where: { tenantId },
      data: { crawl: { ...reach, at: new Date().toISOString() } as never },
    });
  } catch (err: any) {
    console.error(`[business-scan] could not record crawl reach for ${tenantId}:`, err?.message ?? err);
  }
}

/** Where the last scan's unapplied proposal is kept, for the accept path. */
export const SCAN_PROPOSAL_KEY = "profileScanProposal";

export type AcceptOutcome =
  | { ok: true; accepted: string[]; skipped: Array<{ field: string; reason: "not_proposed" | "already_current" }> }
  | { ok: false; reason: "no_proposal" | "no_profile" };

/**
 * Take the website's value for fields a scan offered, and record that those
 * fields now FOLLOW THE SITE.
 *
 * ★ STAMPS `scan`, NOT `human`, and that is the whole point. Provenance answers
 * one question - may a future scan refresh this silently? - so it records what
 * the value TRACKS rather than who clicked. Somebody accepting the website's
 * wording has said "this field follows my site", which is exactly the consent a
 * silent refresh needs. Somebody typing their own has said "this field is mine",
 * which is what `PATCH /api/workspace` means and must keep meaning.
 *
 * ★ UNFORGEABLE BY CONSTRUCTION: the caller names FIELDS, never values. Each
 * value is read from the stored proposal of the last scan. A client cannot mark
 * arbitrary text as website-owned, which matters because the next scan is allowed
 * to overwrite a scan-owned field without asking.
 *
 * A field that was not in the last proposal is skipped with a reason rather than
 * silently ignored, so a stale screen gets told instead of appearing to succeed.
 */
export async function acceptScanProposal(
  tenantId: string,
  fields: string[],
  actorId?: string | null,
): Promise<AcceptOutcome> {
  const raw = await readDurableSetting(tenantId, SCAN_PROPOSAL_KEY);
  if (!raw) return { ok: false, reason: "no_proposal" };

  let offer: RescanPlan["offer"] = [];
  try {
    const parsed = JSON.parse(raw) as { offer?: RescanPlan["offer"] };
    offer = Array.isArray(parsed?.offer) ? parsed.offer : [];
  } catch {
    return { ok: false, reason: "no_proposal" };
  }
  if (offer.length === 0) return { ok: false, reason: "no_proposal" };

  const profile = await prisma.businessProfile.findUnique({
    where: { tenantId },
    select: { organizationName: true, businessDescription: true, industry: true, country: true },
  });
  if (!profile) return { ok: false, reason: "no_profile" };

  const patch: Record<string, unknown> = {};
  const accepted: string[] = [];
  const skipped: Array<{ field: string; reason: "not_proposed" | "already_current" }> = [];

  for (const field of fields) {
    const proposal = offer.find((o) => o.field === field);
    if (!proposal) {
      skipped.push({ field, reason: "not_proposed" });
      continue;
    }
    if (proposal.proposed === (profile as Record<string, unknown>)[field]) {
      // The field already holds the proposed value. Writing would be a no-op,
      // but the STAMP still matters: accepting is how a field becomes
      // scan-owned, so it is recorded rather than skipped as pointless.
      accepted.push(field);
      continue;
    }
    patch[field] = proposal.proposed;
    accepted.push(field);
  }

  if (Object.keys(patch).length > 0) {
    await prisma.businessProfile.update({ where: { tenantId }, data: patch as never });
  }
  if (accepted.length > 0) {
    await stampProvenance(tenantId, accepted, "scan", actorId);
  }

  return { ok: true, accepted, skipped };
}

/** What the rescan did to the knowledge it generated (null when that step failed). */
export interface ScanKnowledge {
  created: number;
  updated: number;
  unchanged: number;
  preserved: number;
  removed: number;
  failed: number;
  /** Topics left out (no facts in them), for the screen to show as gaps. */
  skipped: SkippedTopic[];
}

/** The crawled pages as the projection takes them: titled, with their canonical, the home page marked. */
export function crawlPagesForProjection(origin: string, crawl: { home: { text: string; title?: string | null; canonical?: string | null; siteName?: string | null }; okPages: Array<{ url: string; text: string; title?: string | null; canonical?: string | null }> }) {
  return [
    // The home page is titled by the site, not its hero heading (projectPages).
    { url: origin, content: crawl.home.text, title: crawl.home.title ?? null, canonical: crawl.home.canonical ?? null, home: true, siteName: crawl.home.siteName ?? null },
    // Full page text: the 2800-character cut is only for the model.
    ...crawl.okPages.map((p) => ({ url: p.url, content: p.text, title: p.title ?? null, canonical: p.canonical ?? null })),
  ];
}

export type RescanOutcome =
  | { ok: true; plan: RescanPlan; applied: string[]; reach: CrawlReach; knowledge: ScanKnowledge | null; unchanged?: boolean }
  | {
      ok: false;
      reason: "no_domain" | "fetch_failed" | "scan_failed" | "scan_in_progress" | "no_profile";
      /**
       * Present when the CRAWL ran and the failure came after it.
       *
       * `scan_failed` means the model step failed, not the crawl - so what the
       * crawl could see is already measured and reporting it is free. Withholding
       * it would hide the more useful fact in the case that needs it most: a
       * site that answered every request with a login wall AND an analysis that
       * failed. Absent for `fetch_failed`, where nothing was read, and for the
       * refusals that never reach a crawl.
       */
      reach?: CrawlReach;
    };

/** A scan flagged SCANNING but untouched for this long is treated as crashed. */
const SCAN_STALE_MS = 3 * 60_000;

/**
 * Run a rescan for one tenant and write only what may be written.
 *
 * Shares onboarding's concurrency guard deliberately: both drive the same
 * crawl against the same site and write the same `BusinessDiscovery` row, so
 * two in flight at once is last-writer-wins on a report a customer is watching
 * being built.
 */
export async function runProfileRescan(args: {
  tenantId: string;
  authHeader: string;
  actorId?: string | null;
  locale?: string;
  fetchWithTimeoutFn?: TimedFetch;
  /** Rescan even when the site reads the same as last time (e.g. after a model change). */
  force?: boolean;
}): Promise<RescanOutcome> {
  const { tenantId, authHeader, actorId } = args;
  const fetchWithTimeoutFn = args.fetchWithTimeoutFn ?? defaultFetch;

  const profile = await prisma.businessProfile.findUnique({
    where: { tenantId },
    select: {
      websiteDomain: true,
      organizationName: true,
      businessDescription: true,
      industry: true,
      country: true,
    },
  });
  if (!profile) return { ok: false, reason: "no_profile" };

  const domain = (profile.websiteDomain || "").trim();
  if (!domain) return { ok: false, reason: "no_domain" };
  let origin: string;
  try {
    origin = new URL(domain.startsWith("http") ? domain : `https://${domain}`).origin;
  } catch {
    return { ok: false, reason: "no_domain" };
  }

  const prior = await prisma.businessDiscovery.findUnique({
    where: { tenantId },
    select: { status: true, updatedAt: true },
  });
  if (prior?.status === "SCANNING" && Date.now() - new Date(prior.updatedAt).getTime() < SCAN_STALE_MS) {
    return { ok: false, reason: "scan_in_progress" };
  }

  // The discovery row says what the last scan of the site did, whichever path
  // ran it: onboarding's and this one used to disagree, and a profile rescan
  // left "FAILED" from an earlier discover standing after it succeeded.
  await setDiscoveryStatus(tenantId, { status: "SCANNING", scanPhase: "pages", websiteDomain: origin });

  const crawl = await crawlSite(origin);
  if (!crawl) {
    console.warn(`[business-scan] ${tenantId}: the site ${origin} could not be read`);
    await setDiscoveryStatus(tenantId, { status: "FAILED", scanPhase: "failed" });
    return { ok: false, reason: "fetch_failed" };
  }

  const reach: CrawlReach = {
    requested: crawl.requested.length,
    pagesRead: crawl.pages.length,
    distinctTextPages: crawl.distinctTextPages,
    coverage: crawl.pages.map((p) => p.url),
  };

  // Persisted so the REVIEW screen can see it too, not just the caller of this
  // rescan. Written before the model call, because what the crawl saw is a fact
  // whether or not the analysis afterwards succeeds - and the case that needs it
  // most is a login wall plus a failed scan.
  await persistCrawlReach(tenantId, reach);

  // The site reads exactly as at the last good scan: nothing to learn, and a
  // fresh model wording of the same facts would only churn the description
  // (and with it an employee's readiness questions). No model call, no writes.
  // Compared page by page, so a page that only failed to answer this time is
  // unknown rather than a change (2026-10-14).
  const unreadable: string[] = Array.isArray((crawl as any).unreadable) ? (crawl as any).unreadable : [];
  const lastHashes = parsePageHashes(await readDurableSetting(tenantId, SCAN_CHECKSUM_KEY).catch(() => null));
  const nowHashes = crawlPageHashes(crawl.pages);
  const changed = changedPages(lastHashes, nowHashes, unreadable);
  if (!args.force && changed && changed.length === 0) {
    await setDiscoveryStatus(tenantId, { status: "COMPLETE", scanPhase: "done" });
    return { ok: true, plan: { apply: {}, offer: [] } as any, applied: [], reach, knowledge: null, unchanged: true };
  }
  console.log(`[business-scan] ${tenantId}: full scan (${args.force ? "forced" : changed ? `changed: ${changed.join(", ")}` : "no baseline"}${unreadable.length ? `; unreadable: ${unreadable.join(", ")}` : ""})`);

  const language = await systemLanguage(tenantId, args.locale);
  const report = await callDiscoverBusiness(
    authHeader,
    {
      domain: origin,
      locale: language,
      pages: crawl.pages,
      signals: crawl.signals,
      businessType: crawl.businessType,
    },
    fetchWithTimeoutFn,
  );
  if (!report) {
    console.warn(`[business-scan] ${tenantId}: the analysis of ${origin} failed (see the discover-business line above)`);
    await setDiscoveryStatus(tenantId, { status: "FAILED", scanPhase: "failed" });
    return { ok: false, reason: "scan_failed", reach };
  }

  const provenance = await readProvenance(tenantId);
  const plan = planRescan(provenance, mapReportToProfileFields(report), {
    organizationName: profile.organizationName,
    businessDescription: profile.businessDescription,
    industry: profile.industry,
    country: profile.country,
  });

  // ★ THE PROPOSAL IS STORED SO AN ACCEPT NEVER TAKES A VALUE FROM THE CLIENT.
  // `acceptScanProposal` looks the value up here by field name, which is what
  // makes "mark this field as website-owned" unforgeable: a caller can name a
  // field but cannot choose what the website supposedly said. Without this, an
  // accept endpoint that took {field, value} would let any client mark any text
  // as scan-owned, and the NEXT scan would then silently overwrite a human's
  // words with the website's.
  await writeDurableSetting(
    tenantId,
    SCAN_PROPOSAL_KEY,
    JSON.stringify({ at: new Date().toISOString(), offer: plan.offer }),
  ).catch((err: any) => console.error(`[business-scan] could not store the proposal: ${err?.message}`));

  const applied = Object.keys(plan.apply);
  if (applied.length > 0) {
    await prisma.businessProfile.update({ where: { tenantId }, data: plan.apply as never });
    // Re-stamped as scan-owned. Without this a field written by the scan would
    // fall back to unknown and the NEXT rescan would only offer what this one
    // was allowed to write.
    await stampProvenance(tenantId, applied, "scan", actorId);
  }

  // The knowledge the scan generated follows the site too (2026-10-14): the
  // same projection onboarding's discover runs. Machine-owned documents refresh
  // silently; a document a person edited (manualEdit) is preserved. Without
  // this, an auto-made overview stayed stale forever after a rescan.
  const knowledge = await syncScanKnowledge({ tenantId, origin, report, crawl, language, authHeader, actorId });

  await setDiscoveryStatus(tenantId, { status: "COMPLETE", scanPhase: "done" });
  // Remembered only after a scan that went through, so a failed one is retried
  // in full. A page unreadable this time keeps the hash it had, so its return
  // next time is not mistaken for a new page.
  const remembered: Record<string, string> = { ...nowHashes };
  for (const url of unreadable) if (lastHashes?.[url]) remembered[url] = lastHashes[url]!;
  await writeDurableSetting(tenantId, SCAN_CHECKSUM_KEY, JSON.stringify(remembered)).catch((err: any) => console.error(`[business-scan] could not store the crawl checksum: ${err?.message}`));
  return { ok: true, plan, applied, reach, knowledge };
}

/**
 * What the last good scan read: {url: sha256 of the page's text} (2026-10-14).
 * Was one hash over every page, so a page that timed out once changed it and
 * the next rescan ran in full. An older single-hash value reads as no baseline.
 */
export const SCAN_CHECKSUM_KEY = "profileScanChecksum";

export function crawlPageHashes(pages: Array<{ url: string; text: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pages) {
    out[p.url] = crypto.createHash("sha256").update(String(p.text ?? "").replace(/\s+/g, " ").trim()).digest("hex");
  }
  return out;
}

export function parsePageHashes(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "string" || !raw.startsWith("{")) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/**
 * The pages that differ from the last good scan, [] when none do, or null
 * when there is no baseline to compare with. A page read now with other text,
 * a page new since then, and a page gone since then (not read and not merely
 * unreadable) are changes. A page that could not be read now is not.
 */
export function changedPages(last: Record<string, string> | null, now: Record<string, string>, unreadable: string[]): string[] | null {
  if (!last) return null;
  const changed: string[] = [];
  for (const [url, hash] of Object.entries(now)) if (last[url] !== hash) changed.push(url);
  const skip = new Set(unreadable);
  for (const url of Object.keys(last)) if (!(url in now) && !skip.has(url)) changed.push(url);
  return changed;
}

/**
 * Topics this full scan found thin that may now be retired: only those the
 * previous full scan found thin too (2026-10-14). The thin call reads the
 * model's report, and one run's wording left "contact and hours" without a
 * fact while the site said the same as before, which removed a good document.
 * Remembers this run's list for the next one. Shared by the rescan and
 * onboarding's discover.
 */
export const SCAN_THIN_TOPICS_KEY = "scanThinTopics";

export async function thinTopicsToRetire(tenantId: string, thinNow: string[]): Promise<string[]> {
  let before: string[] = [];
  try {
    const raw = await readDurableSetting(tenantId, SCAN_THIN_TOPICS_KEY);
    const v = typeof raw === "string" ? JSON.parse(raw) : null;
    if (Array.isArray(v)) before = v.map(String);
  } catch { /* no history: retire nothing this time */ }
  await writeDurableSetting(tenantId, SCAN_THIN_TOPICS_KEY, JSON.stringify(thinNow)).catch((err: any) =>
    console.error(`[business-scan] could not store the thin topics: ${err?.message}`));
  return thinNow.filter((t) => before.includes(t));
}

const projectionFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs?: number) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs ?? 30_000) }) as any;

/**
 * Save the report on the discovery row (as discover does) and project it, with
 * the pages read, into the generated knowledge. Never fails the rescan: the
 * profile part already happened; a failure here is logged and reported null.
 */
async function syncScanKnowledge(a: {
  tenantId: string;
  origin: string;
  report: any;
  crawl: Parameters<typeof crawlPagesForProjection>[1];
  language: "he" | "en";
  authHeader: string;
  actorId?: string | null;
}): Promise<ScanKnowledge | null> {
  try {
    const r = a.report ?? {};
    const fields = {
      brand: r.brand ?? undefined,
      business: r.business ?? undefined,
      knowledge: r.knowledge ?? undefined,
      communication: r.communication ?? undefined,
      technology: r.technology ? normalizeDiscoveryTechnology(r.technology) : undefined,
      gaps: r.gaps ?? undefined,
      recommendation: r.recommendation ?? undefined,
      confidence: r.confidence ?? undefined,
      report: r.report ?? undefined,
      scannedAt: new Date(),
    };
    const saved = await prisma.businessDiscovery.upsert({
      where: { tenantId: a.tenantId },
      update: { ...fields, websiteDomain: a.origin } as never,
      create: { tenantId: a.tenantId, status: "SCANNING", websiteDomain: a.origin, ...fields } as never,
    });
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: a.tenantId },
      select: { organizationName: true, industry: true, businessDescription: true, country: true, primaryLanguage: true },
    });
    const ctx = { language: a.language, now: new Date().toISOString() };
    const skipped: SkippedTopic[] = [];
    const projected = [
      ...projectDiscoveryTopics(saved as any, (profile ?? {}) as any, ctx, skipped),
      ...projectPages(crawlPagesForProjection(a.origin, a.crawl), ctx),
    ];
    // A topic is retired only when two full scans in a row found it thin.
    const retireTopics = await thinTopicsToRetire(a.tenantId, skipped.filter((t) => t.reason === "thin").map((t) => t.topic));
    const sync = await applyProjection(
      { prisma, fetchFn: projectionFetch, authHeader: a.authHeader },
      a.tenantId,
      projected,
      // Crawled pages may be retired, except those only unreadable this time,
      // and topics thin twice running. A topic the model simply did not
      // produce keeps last time's.
      { removeMissing: true, removeScope: ["url"], retireTopics, keepUrls: Array.isArray((a.crawl as any).unreadable) ? (a.crawl as any).unreadable : [] },
    );
    void writeAudit({
      tenantId: a.tenantId,
      actorType: "user",
      actorId: a.actorId ?? undefined,
      action: AuditAction.KNOWLEDGE_SCAN_SYNCED,
      targetType: "knowledge_base",
      targetId: sync.knowledgeBaseId ?? "-",
      metadata: { domain: a.origin, via: "rescan", added: sync.added, updated: sync.updated, unchanged: sync.unchanged, preserved: sync.preserved, removed: sync.removed, failed: sync.failed },
    } as any);
    if (!sync.ok) console.warn(`[business-scan] ${a.tenantId}: knowledge sync reported failures (${sync.failed} failed)`);
    return { created: sync.added, updated: sync.updated, unchanged: sync.unchanged, preserved: sync.preserved, removed: sync.removed, failed: sync.failed, skipped };
  } catch (err: any) {
    console.error(`[business-scan] ${a.tenantId}: knowledge sync failed:`, err?.message ?? err);
    return null;
  }
}

/** The discovery row's status, when there is a row. A missed write only costs the status. */
async function setDiscoveryStatus(tenantId: string, data: { status: string; scanPhase: string; websiteDomain?: string }): Promise<void> {
  try {
    await prisma.businessDiscovery.updateMany({ where: { tenantId }, data: data as never });
  } catch (err: any) {
    console.error(`[business-scan] could not record the scan status for ${tenantId}:`, err?.message ?? err);
  }
}

// ─── The rescan as a background run (2026-10-14) ──────────────────────────
//
// A rescan is a crawl plus a model call: 25-40 seconds. The browser and the
// BFF stop waiting at 20, so the screen said "the scan did not run" while the
// scan finished and stored its proposal 20 seconds later. Now POST starts the
// run and answers at once, and GET reports it: running, done (with what was
// applied and offered) or failed (with why).
//
// Kept as TenantSetting "profileScanRun" (no migration). A run still "running"
// after SCAN_STALE_MS died with its process and reads as failed "timed_out".

export const SCAN_RUN_KEY = "profileScanRun";

export type ScanRunStatus = "running" | "done" | "failed";

export interface ScanRun {
  runId: string;
  status: ScanRunStatus;
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  applied: string[];
  offer: unknown[];
  reach: CrawlReach | null;
  /** What happened to the generated knowledge; null until done, or when that step failed. */
  knowledge: ScanKnowledge | null;
  /** True when the site read exactly as at the last good scan: nothing was asked or written. */
  unchanged?: boolean;
}

async function writeRun(tenantId: string, run: ScanRun): Promise<void> {
  try {
    await writeDurableSetting(tenantId, SCAN_RUN_KEY, JSON.stringify(run));
  } catch (err: any) {
    console.error(`[business-scan] could not store the scan run for ${tenantId}:`, err?.message ?? err);
  }
}

/** The last run, or null when none was ever started. */
export async function readScanRun(tenantId: string, now: Date = new Date()): Promise<ScanRun | null> {
  try {
    const raw = await readDurableSetting(tenantId, SCAN_RUN_KEY);
    if (!raw) return null;
    const run = JSON.parse(raw) as ScanRun;
    if (!run || typeof run.startedAt !== "string" || !["running", "done", "failed"].includes(run.status)) return null;
    if (run.status === "running" && now.getTime() - Date.parse(run.startedAt) > SCAN_STALE_MS) {
      return { ...run, status: "failed", reason: "timed_out", finishedAt: null };
    }
    return run;
  } catch {
    return null;
  }
}

/**
 * Start a rescan and return at once. Refused (scan_in_progress) while another
 * run is running. The run finishes into readScanRun; any failure is logged.
 */
export async function startProfileRescan(args: Parameters<typeof runProfileRescan>[0]): Promise<{ started: true; run: ScanRun } | { started: false; reason: "scan_in_progress"; run: ScanRun }> {
  const current = await readScanRun(args.tenantId);
  if (current?.status === "running") return { started: false, reason: "scan_in_progress", run: current };

  const run: ScanRun = {
    runId: crypto.randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    reason: null,
    applied: [],
    offer: [],
    reach: null,
    knowledge: null,
  };
  await writeRun(args.tenantId, run);

  const finish = async (patch: Partial<ScanRun>) => {
    // A newer run owns the record now: leave it alone.
    const latest = await readScanRun(args.tenantId);
    if (latest && latest.runId !== run.runId) return;
    await writeRun(args.tenantId, { ...run, ...patch, finishedAt: new Date().toISOString() });
  };
  void runProfileRescan(args)
    .then(async (outcome) => {
      if (outcome.ok) {
        await finish({ status: "done", applied: outcome.applied, offer: outcome.plan.offer, reach: outcome.reach, knowledge: outcome.knowledge, unchanged: !!outcome.unchanged });
      } else {
        console.warn(`[business-scan] ${args.tenantId}: rescan ended ${outcome.reason}`);
        await finish({ status: "failed", reason: outcome.reason, reach: outcome.reach ?? null });
      }
    })
    .catch(async (err: any) => {
      console.error(`[business-scan] ${args.tenantId}: rescan crashed:`, err?.message ?? err);
      await finish({ status: "failed", reason: "internal_error" });
    });
  return { started: true, run };
}
