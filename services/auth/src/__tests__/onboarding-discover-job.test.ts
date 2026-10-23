/**
 * Learn-the-site as a job (2026-10-23): a real feed, no 409 dead end, a run
 * that survives a reload and stops when superseded.
 *
 * In-memory BusinessDiscovery row (the jobId JSON-path guard included) and
 * fake fetchers - no database, no network, no Redis.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ rows: new Map<string, any>(), enqueued: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const clone = (v: any) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    ...actual,
    prisma: {
      businessDiscovery: {
        findUnique: async ({ where }: any) => { const r = H.rows.get(where.tenantId); return r ? { job: clone(r.job) } : null; },
        upsert: async ({ where, update, create }: any) => {
          const r = H.rows.get(where.tenantId);
          H.rows.set(where.tenantId, r ? { ...r, ...clone(update) } : clone(create));
        },
        updateMany: async ({ where, data }: any) => {
          const r = H.rows.get(where.tenantId);
          if (!r || r.job?.jobId !== where.job.equals) return { count: 0 };
          r.job = clone(data.job);
          return { count: 1 };
        },
      },
      auditLog: { create: async () => ({}) },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; req.userId = "u1"; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/onboarding-discover/queue", () => ({
  enqueueDiscover: async (tenantId: string, jobId: string, attempt = 0) => { H.enqueued.push({ tenantId, jobId, attempt }); },
}));
vi.mock("../services/business-scan.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  systemLanguage: async () => "he",
}));

import { runDiscoverJob } from "../services/onboarding-discover/pipeline";
import { startJob, readJob, viewOf, STALL_MS } from "../services/onboarding-discover/job-store";
import type { Fetcher } from "../services/onboarding-discover/harvest";

const O = "https://shop.example";

function fetcher(map: Record<string, string>): Fetcher {
  return async (url) => (url in map ? { ok: true, status: 200, text: map[url]! } : { ok: false, status: 404, text: "" });
}
const page = (title: string, body: string) => ({
  html: `<html><head><title>${title}</title></head><body><script src="https://cdn.shopify.com/x.js"></script><p>${body}</p><a href="mailto:hi@shop.example">mail</a></body></html>`,
  text: body,
  title,
});
function pages(map: Record<string, ReturnType<typeof page> | "unreadable" | "blocked" | null>) {
  const asked: string[] = [];
  const f = async (url: string) => {
    asked.push(url);
    const v = map[url.replace(/\/$/, "")] ?? map[url];
    if (v === "unreadable") return { unreadable: true as const };
    if (v === "blocked") return { blocked: true as const, reason: "forbidden" as const };
    return v ?? null;
  };
  return Object.assign(f, { asked });
}

const SITE = {
  [`${O}/robots.txt`]: `User-agent: *\nDisallow: /cart\nSitemap: ${O}/sitemap.xml`,
  [`${O}/sitemap.xml`]: `<urlset><url><loc>${O}/pages/faq</loc></url><url><loc>${O}/pages/about</loc></url><url><loc>${O}/cart/x</loc></url></urlset>`,
  [`${O}/products.json?limit=250&page=1`]: JSON.stringify({ products: [{ title: "Shirt", handle: "shirt", product_type: "Tops", variants: [{ price: "120", available: true }] }] }),
  // The probe detection asks when the home page gave no markers (it was blocked).
  [`${O}/products.json?limit=1`]: JSON.stringify({ products: [{ title: "Shirt" }] }),
};
const PAGES = {
  [O]: page("Home", "Welcome"),
  [`${O}/policies/refund-policy`]: page("Refunds", "30 days to return"),
  [`${O}/pages/faq`]: page("FAQ", "Q and A"),
  [`${O}/pages/about`]: page("About", "Our story"),
};

beforeEach(() => { H.rows = new Map(); H.enqueued = []; });

describe("the run", () => {
  it("narrates each real step in order, and the found chips only grow", async () => {
    const job = await startJob("T", O, "he");
    const learnSeen: any[] = [];
    await runDiscoverJob("T", job.jobId, {
      fetch: fetcher(SITE), fetchPage: pages(PAGES) as any, concurrency: 1,
      learn: async (ctx) => { learnSeen.push(ctx.pages.map((p) => p.url)); },
    });
    const out = (await readJob("T"))!;
    expect(out.status).toBe("COMPLETE");
    const keys = out.events.map((e) => e.key);
    expect(keys.slice(0, 7)).toEqual(["job.started", "site.opening", "platform.detected", "products.reading", "products.found", "sitemap.reading", "pages.planned"]);
    expect(keys).toContain("page.reading");
    expect(keys[keys.length - 1]).toBe("job.done");
    expect(out.events.map((e) => e.seq)).toEqual(out.events.map((_, i) => i + 1));
    expect(out.found).toMatchObject({ platform: "shopify", productCount: 1, contact: true });
    // home + the 5 Shopify policy paths + faq + about; 2 of the policies exist.
    expect(out.counts).toMatchObject({ products: 1, pagesPlanned: 8, pagesRead: 4 });
    // robots.txt kept /cart out; the platform's refund policy was read.
    expect(learnSeen[0]).toEqual(expect.arrayContaining([`${O}/policies/refund-policy`, `${O}/pages/faq`]));
    expect(learnSeen[0].some((u: string) => u.includes("/cart"))).toBe(false);
  });

  it("no sitemap at all: the home page's links and the conventional paths are scored instead", async () => {
    const homeWithLinks = { ...page("Home", "Welcome"), html: '<html><body><a href="/returns">Returns</a><a href="/blog/x">Blog</a></body></html>' };
    const job = await startJob("T", O, "he");
    const seen = pages({ [O]: homeWithLinks, [`${O}/returns`]: page("Returns", "14 days") });
    await runDiscoverJob("T", job.jobId, { fetch: fetcher({}), fetchPage: seen as any, concurrency: 1 });
    const out = (await readJob("T"))!;
    expect(out.events.find((e) => e.key === "pages.planned")).toMatchObject({ params: { fromSitemap: false } });
    expect(seen.asked).toContain(`${O}/returns`);
    // Not a Shopify store: Shopify's own conventions are not guessed.
    expect(seen.asked.some((u) => u.includes("/policies/") || u.includes("/pages/"))).toBe(false);
  });

  it("a password-protected store says so instead of pretending it read 40 pages", async () => {
    const pw = page("Enter password", "This store is password protected");
    const job = await startJob("T", O, "he");
    await runDiscoverJob("T", job.jobId, {
      fetch: fetcher(SITE), concurrency: 1,
      fetchPage: pages({ [O]: pw, [`${O}/policies/refund-policy`]: pw, [`${O}/pages/faq`]: pw, [`${O}/pages/about`]: pw }) as any,
    });
    const out = (await readJob("T"))!;
    expect(out.counts.pagesRead).toBe(1);
    expect(out.events.find((e) => e.key === "site.unreadable")).toMatchObject({ kind: "warn", params: { reason: "same_page_everywhere" } });
  });

  it("an unreachable site FAILS with a code the screen can act on", async () => {
    const job = await startJob("T", O, "he");
    await runDiscoverJob("T", job.jobId, { fetch: fetcher({}), fetchPage: pages({ [O]: "unreadable" }) as any });
    const out = (await readJob("T"))!;
    expect(out).toMatchObject({ status: "FAILED", error: { code: "site_unreachable", stage: "detect_platform" } });
    expect(out.events[out.events.length - 1]).toMatchObject({ kind: "error", key: "job.failed" });
  });

  it("a superseded run stops writing the moment the new run takes over", async () => {
    const first = await startJob("T", O, "he");
    let second: any;
    await runDiscoverJob("T", first.jobId, {
      fetch: fetcher(SITE), concurrency: 1,
      fetchPage: (async (url: string) => {
        // The owner typed another domain while the first run was reading.
        if (url.includes("/pages/faq") && !second) second = await startJob("T", "https://other.example", "he");
        return pages(PAGES)(url);
      }) as any,
    });
    const out = (await readJob("T"))!;
    expect(out.jobId).toBe(second.jobId);
    expect(out.events).toEqual([]);
    expect(out.status).toBe("QUEUED");
  });

  it("a failure inside the learn stages is recorded, not swallowed", async () => {
    const job = await startJob("T", O, "he");
    await runDiscoverJob("T", job.jobId, {
      fetch: fetcher(SITE), fetchPage: pages(PAGES) as any,
      learn: async (ctx) => {
        await ctx.emit("extract", "progress", "extract.policies");
        throw Object.assign(new Error("model down"), { code: "extract_failed" });
      },
    });
    expect(await readJob("T")).toMatchObject({ status: "FAILED", error: { code: "extract_failed", stage: "extract" } });
  });
});


describe("a site that refuses an identified crawler", () => {
  it("home blocked: the feed is still harvested, the run completes, and the owner is told why", async () => {
    const job = await startJob("T", O, "he");
    await runDiscoverJob("T", job.jobId, {
      fetch: fetcher(SITE), concurrency: 1,
      fetchPage: pages({ [O]: "blocked", [`${O}/policies/refund-policy`]: "blocked", [`${O}/pages/faq`]: "blocked", [`${O}/pages/about`]: "blocked" }) as any,
    });
    const out = (await readJob("T"))!;
    expect(out.status).toBe("COMPLETE");
    expect(out.events.find((e) => e.key === "site.blocked")).toMatchObject({ kind: "warn", params: { scope: "home", reason: "forbidden" } });
    expect(out.found).toMatchObject({ blocked: true, platform: "shopify", productCount: 1 });
    expect(out.counts).toMatchObject({ pagesRead: 0, pagesBlocked: 4 });
  });

  it("a few pages blocked: counted, the rest read, a softer warning", async () => {
    const job = await startJob("T", O, "he");
    await runDiscoverJob("T", job.jobId, {
      fetch: fetcher(SITE), concurrency: 1,
      fetchPage: pages({ ...PAGES, [`${O}/pages/about`]: "blocked" }) as any,
    });
    const out = (await readJob("T"))!;
    expect(out.counts).toMatchObject({ pagesRead: 3, pagesBlocked: 1 });
    expect(out.events.find((e) => e.key === "pages.blocked")).toMatchObject({ kind: "warn", params: { blocked: 1, of: 8 } });
    expect(out.found.blocked).toBe(false);
  });
});

describe("what counts as blocked", async () => {
  const { blockedReason } = await import("../services/site-crawl.service");
  it.each([
    [403, "", "forbidden"],
    [401, "", "forbidden"],
    [429, "", "rate_limited"],
    [503, "<title>Just a moment...</title><script src=/cdn-cgi/challenge-platform/x>", "challenge"],
    [200, "<div id=cf-browser-verification>", "challenge"],
    [404, "", null],
    [500, "", null],
    [200, "<p>Welcome</p>", null],
  ])("%s → %s", (status, body, want) => expect(blockedReason(status as number, body as string)).toBe(want));
});

describe("reads", () => {
  it("STALLED is derived from an old heartbeat, and ?since returns only newer events", async () => {
    const job = await startJob("T", O, "he");
    job.status = "RUNNING";
    job.events = [1, 2, 3].map((seq) => ({ seq, at: "", stage: "sitemap", kind: "progress", key: "k" }));
    job.heartbeatAt = new Date(Date.now() - STALL_MS - 1000).toISOString();
    const v = viewOf(job, 2);
    expect(v.status).toBe("STALLED");
    expect(v.events.map((e) => e.seq)).toEqual([3]);
  });
});

describe("routes", async () => {
  const { default: onboarding } = await import("../routes/onboarding");
  const app = express();
  app.use(express.json());
  app.use((req: any, _r, n) => { req.tenantId = "T"; n(); });
  app.use("/api/onboarding", onboarding);

  it("POST starts a job and returns 202 at once", async () => {
    const r = await request(app).post("/api/onboarding/discover/job").send({ domain: "shop.example", locale: "he" });
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: "QUEUED", resumed: false });
    expect(H.enqueued).toEqual([{ tenantId: "T", jobId: r.body.data.jobId, attempt: 0 }]);
  });

  it("the same domain while it runs is the SAME job: no 409, no second run", async () => {
    const a = await request(app).post("/api/onboarding/discover/job").send({ domain: "shop.example" });
    const b = await request(app).post("/api/onboarding/discover/job").send({ domain: "https://shop.example/" });
    expect(b.status).toBe(202);
    expect(b.body.data).toMatchObject({ jobId: a.body.data.jobId, resumed: true });
    expect(H.enqueued).toHaveLength(1);
  });

  it("a different domain supersedes it", async () => {
    const a = await request(app).post("/api/onboarding/discover/job").send({ domain: "shop.example" });
    const b = await request(app).post("/api/onboarding/discover/job").send({ domain: "other.example" });
    expect(b.body.data.jobId).not.toBe(a.body.data.jobId);
    expect((await readJob("T"))!.jobId).toBe(b.body.data.jobId);
  });

  it("GET returns the feed after ?since; 404 NO_JOB before any scan", async () => {
    expect((await request(app).get("/api/onboarding/discover/job")).body.code).toBe("NO_JOB");
    const a = await request(app).post("/api/onboarding/discover/job").send({ domain: "shop.example" });
    const r = await request(app).get("/api/onboarding/discover/job?since=0");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ jobId: a.body.data.jobId, domain: O, status: "QUEUED", events: [] });
  });

  it("retry re-queues a FAILED run as a NEW queue job, keeping its feed", async () => {
    const a = await request(app).post("/api/onboarding/discover/job").send({ domain: "shop.example" });
    const row = H.rows.get("T");
    row.job.status = "FAILED";
    row.job.error = { code: "x", stage: "sitemap" };
    row.job.seq = 4;
    const r = await request(app).post("/api/onboarding/discover/retry");
    expect(r.status).toBe(202);
    expect(H.enqueued[H.enqueued.length - 1]).toMatchObject({ jobId: a.body.data.jobId });
    expect(H.enqueued[H.enqueued.length - 1].attempt).toBeGreaterThan(0);
    expect((await readJob("T"))).toMatchObject({ status: "QUEUED", error: null });
  });

  it("an invalid domain is a 400 with a code", async () => {
    const r = await request(app).post("/api/onboarding/discover/job").send({ domain: "not a domain" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_DOMAIN");
  });
});
