/**
 * One learn-the-site run, stage by stage, narrating each real step.
 *
 * detect_platform → harvest_platform → sitemap → read_pages → extract →
 * write_knowledge → suggest_integrations → done
 *
 * Each line on the setup screen is an event this writes as the step happens -
 * there is no timer and no invented percentage. The run belongs to one jobId;
 * when a newer run supersedes it, its next write throws JobSuperseded and it
 * stops. A retry runs the whole pipeline again: fetching is cheap, and the
 * later stages skip the writes recorded in doneStages.
 */
import {
  type FetchedPage,
  type PageFetcher,
  extractSignals,
  fetchPageForCrawl,
  isUnreadable,
  stableTextOf,
  type DiscoverySignals,
} from "../site-crawl.service";
import { type Fetcher, type PlatformHarvest, defaultFetcher, detectPlatform, harvestPlatform } from "./harvest";
import { type PageKind, discoverSitemapUrls, kindOf, planPages } from "./sitemap";
import {
  type DiscoverJob,
  type EventKind,
  type JobCounts,
  type JobFound,
  type Stage,
  JobSuperseded,
  mutateJob,
  pushEvent,
} from "./job-store";

export interface ReadPage { url: string; kind: PageKind; title: string | null; text: string; html: string }

export interface LearnContext {
  tenantId: string;
  jobId: string;
  origin: string;
  locale: string;
  pages: ReadPage[];
  harvest: PlatformHarvest;
  signals: DiscoverySignals;
  emit: Emitter;
  /** Stages whose durable output already exists from an earlier attempt. */
  doneStages: Stage[];
}
/** The stages after reading (extraction, knowledge, suggestions), supplied by the caller. */
export type LearnStages = (ctx: LearnContext) => Promise<void>;

export type Emitter = (
  stage: Stage,
  kind: EventKind,
  key: string,
  params?: Record<string, string | number | boolean | null>,
  patch?: { found?: Partial<JobFound>; counts?: Partial<JobCounts>; stageDone?: Stage },
) => Promise<void>;

export interface PipelineDeps {
  fetch?: Fetcher;
  fetchPage?: PageFetcher;
  learn?: LearnStages;
  /** Reading concurrency: polite on purpose. */
  concurrency?: number;
  heartbeatMs?: number;
}

const READ_CONCURRENCY = 3;
const HEARTBEAT_MS = 15_000;

/** A short, readable path for the feed ("/policies/refund-policy"). */
function pathOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname) || "/"; } catch { return url; }
}

export async function runDiscoverJob(tenantId: string, jobId: string, deps: PipelineDeps = {}): Promise<void> {
  const fetch = deps.fetch ?? defaultFetcher;
  const fetchPage = deps.fetchPage ?? fetchPageForCrawl;
  let stage: Stage = "detect_platform";

  const emit: Emitter = async (s, kind, key, params, patch) => {
    // The learn stages move the run's stage through here, so a failure inside
    // them is recorded against the stage that actually failed.
    stage = s;
    await mutateJob(tenantId, jobId, (job) => {
      job.stage = s;
      pushEvent(job, s, kind, key, params);
      if (patch?.found) {
        const f = patch.found;
        // Cumulative: lists merge, counts take the larger value, flags only turn on.
        for (const [k, v] of Object.entries(f) as Array<[keyof JobFound, any]>) {
          const cur = job.found[k] as any;
          if (Array.isArray(cur)) (job.found as any)[k] = Array.from(new Set([...cur, ...(v as any[])]));
          else if (typeof cur === "number") (job.found as any)[k] = Math.max(cur, Number(v) || 0);
          else if (typeof cur === "boolean") (job.found as any)[k] = cur || !!v;
          else (job.found as any)[k] = v ?? cur;
        }
      }
      if (patch?.counts) Object.assign(job.counts, patch.counts);
      if (patch?.stageDone && !job.doneStages.includes(patch.stageDone)) job.doneStages.push(patch.stageDone);
    });
  };

  const start = await mutateJob(tenantId, jobId, (job) => {
    job.status = "RUNNING";
    pushEvent(job, job.stage, "progress", "job.started", { domain: job.domain });
  });
  const origin = start.domain;
  const doneStages = [...start.doneStages];

  // A long extraction call must not look like a dead job.
  const beat = setInterval(() => {
    mutateJob(tenantId, jobId, () => {}).catch(() => {});
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  if (typeof (beat as any).unref === "function") (beat as any).unref();

  try {
    // ── detect_platform ──
    stage = "detect_platform";
    await emit(stage, "progress", "site.opening", { domain: origin });
    let home = await fetchPage(origin);
    if (isUnreadable(home)) home = await fetchPage(origin, 15_000);
    if (!home || isUnreadable(home)) {
      await fail(tenantId, jobId, stage, "site_unreachable");
      return;
    }
    const homePage = home as FetchedPage;
    const homeSignals = extractSignals([{ url: origin, html: homePage.html }]);
    const platform = await detectPlatform(origin, homeSignals.platform?.slug, fetch);
    await emit(stage, "found", platform ? "platform.detected" : "platform.none", platform ? { platform } : undefined, {
      found: { platform: platform ?? null },
    });

    // ── harvest_platform ──
    stage = "harvest_platform";
    let harvest: PlatformHarvest = { platform: null, products: null, policyUrls: [] };
    if (platform) {
      await emit(stage, "progress", "products.reading", { platform });
      harvest = await harvestPlatform(origin, platform, fetch);
      if (harvest.products) {
        await emit(stage, "found", "products.found", { count: harvest.products.count, more: harvest.products.more }, {
          found: { productCount: harvest.products.count },
          counts: { products: harvest.products.count },
        });
      } else if (harvest.feedUnavailable) {
        await emit(stage, "warn", "products.feed_unavailable", { platform, reason: harvest.feedUnavailable });
      }
    }

    // ── sitemap ──
    stage = "sitemap";
    await emit(stage, "progress", "sitemap.reading");
    const sm = await discoverSitemapUrls(origin, fetch);
    const plan = planPages({
      origin,
      sitemapUrls: sm.urls,
      platformPolicyUrls: harvest.policyUrls,
      haveProductFeed: !!harvest.products,
      robots: sm.robots,
    });
    await emit(stage, "progress", "pages.planned", { count: plan.length, fromSitemap: sm.urls.length > 0 }, {
      counts: { pagesPlanned: plan.length },
    });

    // ── read_pages ──
    stage = "read_pages";
    const pages: ReadPage[] = [{ url: origin, kind: "page", title: homePage.title ?? null, text: homePage.text, html: homePage.html }];
    const texts = new Set<string>([stableTextOf(homePage.html)]);
    const todo = plan.filter((p) => p.url !== origin && p.url !== origin.replace(/\/$/, ""));
    let next = 0;
    let read = 1;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++]!;
        await emit(stage, "progress", "page.reading", { path: pathOf(p.url), kind: p.kind });
        const r = await fetchPage(p.url, 8000);
        if (!r || isUnreadable(r)) continue;
        const page = r as FetchedPage;
        const stable = stableTextOf(page.html);
        // A password-protected store answers every path with the same page.
        if (texts.has(stable)) continue;
        texts.add(stable);
        pages.push({ url: p.url, kind: p.kind === "other" ? kindOf(p.url) : p.kind, title: page.title ?? null, text: page.text, html: page.html });
        read++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? READ_CONCURRENCY, todo.length || 1) }, worker));

    const signals = extractSignals(pages.map((p) => ({ url: p.url, html: p.html })));
    const tools = signals.tools ?? [];
    await emit(stage, "progress", "pages.read", { count: read }, {
      counts: { pagesRead: read },
      found: {
        tools,
        contact: signals.emails.length + signals.phones.length + signals.whatsapp.length > 0,
      },
    });
    for (const slug of tools) await emit(stage, "found", "tool.detected", { slug });
    if (read <= 1 && plan.length > 1) {
      await emit(stage, "warn", "site.unreadable", { reason: texts.size <= 1 ? "same_page_everywhere" : "pages_unreadable" });
    }

    // ── extract → write_knowledge → suggest_integrations ──
    if (deps.learn) {
      await deps.learn({ tenantId, jobId, origin, locale: start.locale, pages, harvest, signals, emit, doneStages });
    }

    stage = "done";
    await mutateJob(tenantId, jobId, (job) => {
      job.status = "COMPLETE";
      job.stage = "done";
      job.finishedAt = new Date().toISOString();
      pushEvent(job, "done", "progress", "job.done");
    });
  } catch (err: any) {
    if (err instanceof JobSuperseded) return;
    console.error(`[onboarding-discover] ${tenantId} ${jobId} failed at ${stage}:`, err?.message ?? err);
    await fail(tenantId, jobId, stage, err?.code ?? "stage_failed").catch(() => {});
  } finally {
    clearInterval(beat);
  }
}

async function fail(tenantId: string, jobId: string, stage: Stage, code: string): Promise<void> {
  await mutateJob(tenantId, jobId, (job: DiscoverJob) => {
    job.status = "FAILED";
    job.stage = stage;
    job.error = { code, stage };
    job.finishedAt = new Date().toISOString();
    pushEvent(job, stage, "error", "job.failed", { code });
  }).catch((err) => {
    if (!(err instanceof JobSuperseded)) throw err;
  });
}
