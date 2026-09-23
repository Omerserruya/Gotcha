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
import { prisma } from "@chatcenter/shared";
import { crawlSite } from "./site-crawl.service";
import {
  readProvenance,
  stampProvenance,
  planRescan,
  type RescanPlan,
} from "./field-provenance.service";

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");

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
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { ok?: boolean; report?: any } };
    if (!json?.data?.ok || !json.data.report) return null;
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

export type RescanOutcome =
  | { ok: true; plan: RescanPlan; applied: string[] }
  | { ok: false; reason: "no_domain" | "fetch_failed" | "scan_failed" | "scan_in_progress" | "no_profile" };

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

  const crawl = await crawlSite(origin);
  if (!crawl) return { ok: false, reason: "fetch_failed" };

  const report = await callDiscoverBusiness(
    authHeader,
    {
      domain: origin,
      locale: args.locale || "en",
      pages: crawl.pages,
      signals: crawl.signals,
      businessType: crawl.businessType,
    },
    fetchWithTimeoutFn,
  );
  if (!report) return { ok: false, reason: "scan_failed" };

  const provenance = await readProvenance(tenantId);
  const plan = planRescan(provenance, mapReportToProfileFields(report), {
    organizationName: profile.organizationName,
    businessDescription: profile.businessDescription,
    industry: profile.industry,
    country: profile.country,
  });

  const applied = Object.keys(plan.apply);
  if (applied.length > 0) {
    await prisma.businessProfile.update({ where: { tenantId }, data: plan.apply as never });
    // Re-stamped as scan-owned. Without this a field written by the scan would
    // fall back to unknown and the NEXT rescan would only offer what this one
    // was allowed to write.
    await stampProvenance(tenantId, applied, "scan", actorId);
  }

  return { ok: true, plan, applied };
}
