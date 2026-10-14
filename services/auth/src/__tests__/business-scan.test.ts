/**
 * "Scan again": what it may write, and what it must only propose.
 *
 * The crawl itself is covered by site-crawl-extraction.test.ts against a golden
 * captured from the pre-extraction code. This covers the layer above it - which
 * report fields become profile fields, and what happens to each one given who
 * owns it.
 *
 * The live route can only be exercised as far as its refusals on this stack:
 * the dev tenant with a website is out of AI units, so a real run stops at the
 * model call. Everything past that point is pinned here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Typed loosely on purpose: these stand in for Prisma delegates whose real
// signatures are generated, and a narrow inferred type here made `tsc` reject
// the test while vitest ran it happily - esbuild strips types without checking
// them, so a test file can pass its suite and fail the typecheck.
const prismaMock = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn<(...a: any[]) => any>() },
  businessProfile: { findUnique: vi.fn<(...a: any[]) => any>(), update: vi.fn<(...a: any[]) => any>() },
  businessDiscovery: { findUnique: vi.fn<(...a: any[]) => any>(), updateMany: vi.fn<(...a: any[]) => any>(), upsert: vi.fn<(...a: any[]) => any>() },
}));
const crawlMock = vi.hoisted(() => vi.fn<(...a: any[]) => any>());
const provenanceMock = vi.hoisted(() => ({
  readProvenance: vi.fn<(...a: any[]) => any>(),
  stampProvenance: vi.fn<(...a: any[]) => any>(),
}));

const settings = vi.hoisted(() => ({ store: {} as Record<string, string>, writes: [] as string[] }));
const projectionMock = vi.hoisted(() => ({ apply: vi.fn<(...a: any[]) => any>(), audits: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  // The projection RULES are the real ones (what a rescan would write); only
  // the database and the writes are doubles.
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    prisma: prismaMock,
    readDurableSetting: async (_t: string, k: string) => settings.store[k] ?? null,
    writeDurableSetting: async (_t: string, k: string, v: string) => { settings.store[k] = v; settings.writes.push(k); },
    normalizeDiscoveryTechnology: actual.normalizeDiscoveryTechnology,
    projectDiscoveryTopics: actual.projectDiscoveryTopics,
    projectPages: actual.projectPages,
    AuditAction: actual.AuditAction,
    writeAudit: async (e: any) => { projectionMock.audits.push(e); },
  };
});
vi.mock("../services/onboarding-knowledge.service", () => ({ applyProjection: projectionMock.apply }));
vi.mock("../services/site-crawl.service", () => ({ crawlSite: crawlMock }));
vi.mock("../services/field-provenance.service", async () => {
  // The RULE is not mocked - planRescan is the thing under test here, and a
  // stubbed rule would make every assertion below describe the stub.
  const real = await vi.importActual<typeof import("../services/field-provenance.service")>(
    "../services/field-provenance.service",
  );
  return { ...real, readProvenance: provenanceMock.readProvenance, stampProvenance: provenanceMock.stampProvenance };
});

import { mapReportToProfileFields, runProfileRescan, acceptScanProposal, SCAN_PROPOSAL_KEY, startProfileRescan, readScanRun, SCAN_RUN_KEY, SCAN_CHECKSUM_KEY, SCAN_THIN_TOPICS_KEY } from "../services/business-scan.service";

/** The discovery writes that record what the crawl saw (the others record the status). */
const crawlWrites = () => (prismaMock.businessDiscovery.updateMany.mock.calls as any[]).map((c) => c[0]).filter((a) => a.data.crawl);
const statusWrites = () => (prismaMock.businessDiscovery.updateMany.mock.calls as any[]).map((c) => c[0].data.status).filter(Boolean);

const PROFILE = {
  websiteDomain: "https://shop.example.com",
  organizationName: "Old Name",
  businessDescription: "Old description",
  industry: "Retail",
  country: "Israel",
};

const REPORT = {
  business: { name: "New Name", country: "Israel", industry: "Outdoor gear", summary: "New description" },
  brand: { languages: ["Hebrew", "English"] },
};

function okFetch(report: unknown = REPORT) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true, report } }) }) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.store = {};
  settings.writes = [];
  prismaMock.businessProfile.findUnique.mockResolvedValue({ ...PROFILE });
  prismaMock.businessProfile.update.mockResolvedValue({});
  prismaMock.tenant.findUnique.mockResolvedValue({ defaultLocale: "en" });
  prismaMock.businessDiscovery.findUnique.mockResolvedValue(null);
  prismaMock.businessDiscovery.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.businessDiscovery.upsert.mockImplementation(async (a: any) => ({ tenantId: "t1", ...a.update }));
  projectionMock.apply.mockResolvedValue({ ok: true, knowledgeBaseId: "kb1", added: 1, updated: 2, unchanged: 3, preserved: 1, removed: 0, failed: 0, details: [] });
  projectionMock.audits = [];
  provenanceMock.readProvenance.mockResolvedValue({});
  crawlMock.mockResolvedValue({
    pages: [],
    signals: {},
    businessType: "ecommerce",
    requested: [],
    distinctTextPages: 0,
  });
});

describe("which report fields the scan may speak for", () => {
  it("maps name, country, industry and summary", () => {
    expect(mapReportToProfileFields(REPORT)).toEqual({
      organizationName: "New Name",
      country: "Israel",
      industry: "Outdoor gear",
      businessDescription: "New description",
    });
  });

  it("never proposes a language", () => {
    // brand.languages is free text ("Hebrew"); the column holds ISO-639-1.
    // Inventing that mapping would write a confidently wrong value into a
    // field the AI reads on every reply.
    expect(mapReportToProfileFields(REPORT)).not.toHaveProperty("primaryLanguage");
  });

  it("drops empty strings rather than proposing a blank", () => {
    const mapped = mapReportToProfileFields({ business: { name: "  ", industry: "Retail" } });

    // "" means the model found nothing, which must reach the rule as an ABSENT
    // field, not as a value it might be asked to write.
    expect(mapped).toEqual({ industry: "Retail" });
  });

  it("survives a malformed report instead of throwing", () => {
    expect(mapReportToProfileFields(null)).toEqual({});
    expect(mapReportToProfileFields({ business: "nonsense" })).toEqual({});
  });
});

describe("what a rescan writes", () => {
  it("writes only the fields the scan owns, and offers the rest", async () => {
    provenanceMock.readProvenance.mockResolvedValue({
      industry: { source: "scan", at: "2026-01-01T00:00:00.000Z" },
      businessDescription: { source: "human", at: "2026-01-01T00:00:00.000Z" },
    });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toEqual(["industry"]);
    expect((prismaMock.businessProfile.update.mock.calls[0] as any[])[0].data).toEqual({ industry: "Outdoor gear" });

    const offered = outcome.plan.offer.map((o) => [o.field, o.because]);
    // The human-edited description is offered, not written.
    expect(offered).toContainEqual(["businessDescription", "human_edited"]);
    // organizationName has never been marked by anyone.
    expect(offered).toContainEqual(["organizationName", "source_unknown"]);
    // country is unchanged, so it is neither written nor offered.
    expect(outcome.plan.offer.some((o) => o.field === "country")).toBe(false);
  });

  it("re-stamps what it wrote as scan-owned", async () => {
    provenanceMock.readProvenance.mockResolvedValue({ industry: { source: "scan", at: "2026-01-01T00:00:00.000Z" } });

    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", actorId: "u1", fetchWithTimeoutFn: okFetch() });

    // Without this the field would fall back to unknown and the NEXT rescan
    // would only be able to offer what this one was allowed to write.
    expect(provenanceMock.stampProvenance).toHaveBeenCalledWith("t1", ["industry"], "scan", "u1");
  });

  it("writes nothing at all when the scan owns nothing", async () => {
    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toEqual([]);
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
    expect(provenanceMock.stampProvenance).not.toHaveBeenCalled();
    // Everything the scan found is still reported, so the screen can offer it.
    expect(outcome.plan.offer.length).toBeGreaterThan(0);
  });
});

describe("when it refuses", () => {
  it("reports no_profile rather than creating one", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue(null);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome).toEqual({ ok: false, reason: "no_profile" });
  });

  it("reports no_domain when no website has been given", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue({ ...PROFILE, websiteDomain: "" });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome).toEqual({ ok: false, reason: "no_domain" });
    expect(crawlMock).not.toHaveBeenCalled();
  });

  it("refuses while onboarding's scan is still running", async () => {
    prismaMock.businessDiscovery.findUnique.mockResolvedValue({ status: "SCANNING", updatedAt: new Date() });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    // Both drive the same crawl into the same row; two at once is
    // last-writer-wins on a report someone is watching being built.
    expect(outcome).toEqual({ ok: false, reason: "scan_in_progress" });
    expect(crawlMock).not.toHaveBeenCalled();
  });

  it("restarts after a scan that was left flagged and never finished", async () => {
    prismaMock.businessDiscovery.findUnique.mockResolvedValue({
      status: "SCANNING",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    // A stale flag must never trap a tenant out of ever scanning again.
    expect(outcome.ok).toBe(true);
  });

  it("writes nothing when the site cannot be read", async () => {
    crawlMock.mockResolvedValue(null);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome).toEqual({ ok: false, reason: "fetch_failed" });
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });

  it("writes nothing when the model is unavailable, but STILL reports what the crawl saw", async () => {
    // The live case on this stack: the tenant is out of AI units, so every real
    // run ends here. Withholding `reach` would hide the more useful fact in
    // exactly the case that needs it - an unreadable site AND a failed analysis.
    const pages = [{ url: "https://shop.example.com", text: "password protected" }];
    crawlMock.mockResolvedValue({
      pages,
      signals: {},
      businessType: "ecommerce",
      requested: pages.map((p) => p.url),
      distinctTextPages: 1,
    });
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as any);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("scan_failed");
    expect(outcome.reach?.distinctTextPages).toBe(1);
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });

  it("reports no reach when the site could not be read at all", async () => {
    crawlMock.mockResolvedValue(null);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Nothing was read, so there is nothing to report. An empty reach would
    // claim a measurement that never happened.
    expect(outcome.reach).toBeUndefined();
  });
});

describe("what the crawl could see is reported to the screen", () => {
  it("★ reports distinctTextPages so a login wall cannot look like 17 pages read", async () => {
    // The dev tenant's own store: every path answers 200 with the same login
    // page. pagesRead is 17 and the crawl saw ONE page.
    const wall = Array.from({ length: 17 }, (_, i) => ({ url: `https://shop.example.com/p${i}`, text: "password protected" }));
    crawlMock.mockResolvedValue({
      pages: wall,
      signals: {},
      businessType: "ecommerce",
      requested: wall.map((p) => p.url),
      distinctTextPages: 1,
    });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reach.pagesRead).toBe(17);
    // The number a screen may quote. Without it, 17 reads as success.
    expect(outcome.reach.distinctTextPages).toBe(1);
    expect(outcome.reach.coverage).toHaveLength(17);
  });

  it("reports a readable site as readable", async () => {
    const pages = [
      { url: "https://shop.example.com", text: "home" },
      { url: "https://shop.example.com/about", text: "about us" },
    ];
    crawlMock.mockResolvedValue({
      pages,
      signals: {},
      businessType: "ecommerce",
      requested: pages.map((p) => p.url),
      distinctTextPages: 2,
    });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reach.distinctTextPages).toBe(2);
  });
});

describe("what the crawl saw is PERSISTED, not only returned", () => {
  it("★ records the reach on the discovery row so the review screen can see it too", async () => {
    const pages = Array.from({ length: 17 }, (_, i) => ({ url: `https://shop.example.com/p${i}`, text: "password protected" }));
    crawlMock.mockResolvedValue({
      pages,
      signals: {},
      businessType: "ecommerce",
      requested: pages.map((p) => p.url),
      distinctTextPages: 1,
    });

    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(crawlWrites()).toHaveLength(1);
    const written = crawlWrites()[0];
    expect(written.where).toEqual({ tenantId: "t1" });
    expect(written.data.crawl.distinctTextPages).toBe(1);
    expect(written.data.crawl.pagesRead).toBe(17);
    expect(typeof written.data.crawl.at).toBe("string");
  });

  it("records it even when the MODEL fails afterwards", async () => {
    // The case that needs it most: a login wall AND a failed analysis. What the
    // crawl saw is a fact whether or not the model succeeded.
    const pages = [{ url: "https://shop.example.com", text: "password protected" }];
    crawlMock.mockResolvedValue({ pages, signals: {}, businessType: "ecommerce", requested: ["u"], distinctTextPages: 1 });
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as any);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });

    expect(outcome.ok).toBe(false);
    expect(crawlWrites()).toHaveLength(1);
  });

  it("does not record anything when the site could not be read at all", async () => {
    crawlMock.mockResolvedValue(null);

    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    // Nothing was read, so there is no measurement. Writing zeros would claim
    // one that never happened - the same reason the column has no default.
    expect(crawlWrites()).toEqual([]);
  });

  it("a missing discovery row does not fail the scan", async () => {
    // A rescan can run before onboarding's scan ever did. updateMany matches
    // nothing and that is fine.
    prismaMock.businessDiscovery.updateMany.mockResolvedValue({ count: 0 });
    crawlMock.mockResolvedValue({ pages: [{ url: "u", text: "t" }], signals: {}, businessType: "x", requested: ["u"], distinctTextPages: 1 });

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(outcome.ok).toBe(true);
  });
});

/**
 * The mechanism had a FIXED POINT AT EMPTY and every transition was correct.
 *
 * `scan` ownership could only be written for fields that were ALREADY scan-owned,
 * so the set started empty and nothing could add to it: every scan offered
 * everything and applied nothing, forever. Accepting a suggestion meant PATCHing
 * the value, which stamps `human` and guarantees the same field is offered again.
 *
 * So these tests are about REACHABILITY, not transitions. The transitions were
 * never the problem.
 */
describe("accepting a proposal is how scan ownership becomes reachable", () => {
  const PROPOSAL = JSON.stringify({
    at: "2026-09-24T07:00:00.000Z",
    offer: [
      { field: "businessDescription", current: "typed by owner", proposed: "from the site", because: "human_edited" },
      { field: "industry", current: "Retail", proposed: "Outdoor gear", because: "source_unknown" },
    ],
  });

  it("★ stamps scan, not human, because provenance records what the value TRACKS", async () => {
    settings.store[SCAN_PROPOSAL_KEY] = PROPOSAL;

    const outcome = await acceptScanProposal("t1", ["industry"], "u1");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted).toEqual(["industry"]);
    // A person accepting the website's value has said "this field follows my
    // site". Stamping human would guarantee it is offered again next scan.
    expect(provenanceMock.stampProvenance).toHaveBeenCalledWith("t1", ["industry"], "scan", "u1");
  });

  it("★ takes the value from the STORED proposal, never from the caller", async () => {
    settings.store[SCAN_PROPOSAL_KEY] = PROPOSAL;

    await acceptScanProposal("t1", ["industry"], "u1");

    const data = (prismaMock.businessProfile.update.mock.calls[0] as any[])[0].data;
    // The caller named a field and got the website's value. It could not have
    // supplied one - which is what stops a client marking arbitrary text as
    // website-owned, given a scan may later overwrite a scan-owned field.
    expect(data).toEqual({ industry: "Outdoor gear" });
  });

  it("★ refuses a field the last scan never proposed, rather than stamping it", async () => {
    settings.store[SCAN_PROPOSAL_KEY] = PROPOSAL;

    const outcome = await acceptScanProposal("t1", ["organizationName"], "u1");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The forgery attempt: naming an unproposed field to mark it scan-owned.
    expect(outcome.accepted).toEqual([]);
    expect(outcome.skipped).toEqual([{ field: "organizationName", reason: "not_proposed" }]);
    expect(provenanceMock.stampProvenance).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });

  it("accepts several fields at once and writes them together", async () => {
    settings.store[SCAN_PROPOSAL_KEY] = PROPOSAL;

    const outcome = await acceptScanProposal("t1", ["industry", "businessDescription"], "u1");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted.sort()).toEqual(["businessDescription", "industry"]);
    expect(prismaMock.businessProfile.update).toHaveBeenCalledTimes(1);
  });

  it("stamps a field that already holds the proposed value", async () => {
    // The write is a no-op; the STAMP is the point. Accepting is how the field
    // becomes refreshable, so skipping it as pointless would leave the fixed
    // point in place for exactly the fields already in agreement.
    settings.store[SCAN_PROPOSAL_KEY] = JSON.stringify({
      at: "x",
      offer: [{ field: "industry", current: "Retail", proposed: "Retail", because: "source_unknown" }],
    });

    const outcome = await acceptScanProposal("t1", ["industry"], "u1");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted).toEqual(["industry"]);
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
    expect(provenanceMock.stampProvenance).toHaveBeenCalledWith("t1", ["industry"], "scan", "u1");
  });

  it("says no_proposal when no scan has run, rather than accepting nothing quietly", async () => {
    const outcome = await acceptScanProposal("t1", ["industry"], "u1");

    expect(outcome).toEqual({ ok: false, reason: "no_proposal" });
  });

  it("survives a corrupt stored proposal", async () => {
    settings.store[SCAN_PROPOSAL_KEY] = "{not json";

    const outcome = await acceptScanProposal("t1", ["industry"], "u1");

    expect(outcome).toEqual({ ok: false, reason: "no_proposal" });
  });

  it("★ the rescan STORES its proposal, or nothing could ever be accepted", async () => {
    crawlMock.mockResolvedValue({
      pages: [{ url: "u", text: "t" }],
      signals: {},
      businessType: "x",
      requested: ["u"],
      distinctTextPages: 1,
    });

    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    expect(settings.writes).toContain(SCAN_PROPOSAL_KEY);
    const stored = JSON.parse(settings.store[SCAN_PROPOSAL_KEY]!);
    expect(Array.isArray(stored.offer)).toBe(true);
    expect(stored.offer.length).toBeGreaterThan(0);
  });
});

describe("★ the discovery row says what the last scan did (2026-10-14)", () => {
  it("success: SCANNING with the site, then COMPLETE", async () => {
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(statusWrites()).toEqual(["SCANNING", "COMPLETE"]);
    const first = (prismaMock.businessDiscovery.updateMany.mock.calls[0] as any[])[0];
    expect(first).toEqual({ where: { tenantId: "t1" }, data: { status: "SCANNING", scanPhase: "pages", websiteDomain: "https://shop.example.com" } });
  });

  it("the model failing: FAILED, and the log says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => ({ ok: false, status: 401, text: async () => "no tenant", json: async () => ({}) }) as any);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });
    expect(statusWrites()).toEqual(["SCANNING", "FAILED"]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("discover-business answered 401: no tenant"))).toBe(true);
    expect(lines.some((l) => l.includes("the analysis of https://shop.example.com failed"))).toBe(true);
    warn.mockRestore();
  });

  it("a report-less answer is logged too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: false } }) }) as any);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: empty });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("returned no report"))).toBe(true);
    warn.mockRestore();
  });

  it("the site unreadable: FAILED", async () => {
    crawlMock.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(statusWrites()).toEqual(["SCANNING", "FAILED"]);
  });

  it("refusals before the crawl write no status", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue({ ...PROFILE, websiteDomain: "" });
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(statusWrites()).toEqual([]);
  });
});

describe("★ the rescan runs in the background and is read back (2026-10-14)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("starts at once as running, and ends done with what was applied and offered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn(async () => { await gate; return { ok: true, json: async () => ({ data: { ok: true, report: REPORT } }) }; }) as any;
    const started = await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: slow });
    expect(started.started).toBe(true);
    expect((await readScanRun("t1"))?.status).toBe("running");
    release();
    await flush();
    const run = await readScanRun("t1");
    expect(run).toMatchObject({ status: "done", reason: null });
    expect(run!.offer.length).toBeGreaterThan(0);
    expect(typeof run!.finishedAt).toBe("string");
  });

  it("★ a second start while one runs is refused, and the first is untouched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn(async () => { await gate; return { ok: true, json: async () => ({ data: { ok: true, report: REPORT } }) }; }) as any;
    const a = await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: slow });
    const b = await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: slow });
    expect(b).toMatchObject({ started: false, reason: "scan_in_progress" });
    expect(b.run.startedAt).toBe(a.run.startedAt);
    release();
    await flush();
  });

  it("a failed run says why", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => ({ ok: false, status: 502, text: async () => "", json: async () => ({}) }) as any);
    await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });
    await flush();
    expect(await readScanRun("t1")).toMatchObject({ status: "failed", reason: "scan_failed" });
  });

  it("a crash is a failed run (internal_error), logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    crawlMock.mockRejectedValue(new Error("boom"));
    await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    await flush();
    expect(await readScanRun("t1")).toMatchObject({ status: "failed", reason: "internal_error" });
    expect(err.mock.calls.some((c) => String(c[0]).includes("rescan crashed"))).toBe(true);
  });

  it("★ a run left running past 3 minutes reads as failed timed_out, and a new one may start", async () => {
    settings.store[SCAN_RUN_KEY] = JSON.stringify({ runId: "old", status: "running", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), finishedAt: null, reason: null, applied: [], offer: [], reach: null });
    expect(await readScanRun("t1")).toMatchObject({ status: "failed", reason: "timed_out" });
    const again = await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(again.started).toBe(true);
    await flush();
  });

  it("never started: null", async () => {
    expect(await readScanRun("t1")).toBeNull();
  });
});

describe("★ the rescan refreshes the knowledge it generated (2026-10-14)", () => {
  const SITE = {
    pages: [{ url: "https://shop.example.com/shipping", text: "short" }],
    okPages: [{ url: "https://shop.example.com/shipping", text: "Free shipping over 299. Returns within 30 days. ".repeat(80) }],
    home: { html: "<html></html>", text: "HALVO clothing, designed in Copenhagen." },
    signals: {},
    businessType: "ecommerce",
    requested: ["https://shop.example.com/shipping"],
    distinctTextPages: 2,
  };

  it("★ saves the report on the discovery row and projects it with the FULL page text", async () => {
    crawlMock.mockResolvedValue(SITE);
    const outcome: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer user", actorId: "u1", locale: "he", fetchWithTimeoutFn: okFetch() });
    expect(outcome.ok).toBe(true);
    const up = (prismaMock.businessDiscovery.upsert.mock.calls[0] as any[])[0];
    expect(up.where).toEqual({ tenantId: "t1" });
    expect(up.update).toMatchObject({ business: REPORT.business, websiteDomain: "https://shop.example.com" });
    const [deps, tenant, projected, options] = projectionMock.apply.mock.calls[0] as any[];
    expect(deps.authHeader).toBe("Bearer user");
    expect(tenant).toBe("t1");
    // Pages may be retired, and topics thin two scans running (2026-10-14):
    // this is the first, so none.
    expect(options).toMatchObject({ removeMissing: true, removeScope: ["url"], retireTopics: [], keepUrls: [] });
    const page = projected.find((e: any) => e.metadata?.sourceUrl === "https://shop.example.com/shipping" || String(e.metadata?.dedupeKey).includes("shipping"));
    expect(page).toBeTruthy();
    // Not the 2800-character model cut.
    expect(page.content.length).toBeGreaterThan(2800);
    expect(projected.some((e: any) => e.metadata?.topic === "business_overview")).toBe(true);
    expect(outcome.knowledge).toMatchObject({ created: 1, updated: 2, unchanged: 3, preserved: 1, removed: 0, failed: 0 });
    expect(projectionMock.audits[0]).toMatchObject({ actorId: "u1", metadata: { via: "rescan", added: 1, preserved: 1 } });
  });

  it("the background run reports the knowledge counts", async () => {
    crawlMock.mockResolvedValue(SITE);
    await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    await new Promise((r) => setTimeout(r, 10));
    expect((await readScanRun("t1"))?.knowledge).toMatchObject({ created: 1, updated: 2, unchanged: 3, preserved: 1, removed: 0, failed: 0 });
  });

  it("★ a failed knowledge step never fails the rescan: knowledge null, logged", async () => {
    crawlMock.mockResolvedValue(SITE);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    projectionMock.apply.mockRejectedValue(new Error("ai down"));
    const outcome: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(outcome.ok).toBe(true);
    expect(outcome.knowledge).toBeNull();
    expect(err.mock.calls.some((c) => String(c[0]).includes("knowledge sync failed"))).toBe(true);
    expect(statusWrites().at(-1)).toBe("COMPLETE");
  });

  it("no report (the model failed): no knowledge step at all", async () => {
    crawlMock.mockResolvedValue(SITE);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) }) as any);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });
    expect(projectionMock.apply).not.toHaveBeenCalled();
    expect(prismaMock.businessDiscovery.upsert).not.toHaveBeenCalled();
  });
});

describe("★ the scan writes in the workspace's system language (2026-10-14)", () => {
  const SITE = {
    pages: [{ url: "https://shop.example.com/faq", text: "x" }],
    okPages: [{ url: "https://shop.example.com/faq", text: "Frequently asked questions about orders and sizing.", title: "FAQ", canonical: null }],
    home: { html: "", text: "HALVO clothing, designed in Copenhagen.", title: "HALVO", canonical: null },
    signals: {}, businessType: "ecommerce", requested: ["u"], distinctTextPages: 2,
  };

  it("★ a Hebrew workspace asks ai in Hebrew and gets Hebrew topics, whatever the request said", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ defaultLocale: "he" });
    crawlMock.mockResolvedValue(SITE);
    const fetchFn = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", locale: "en", fetchWithTimeoutFn: fetchFn });
    const body = JSON.parse((fetchFn.mock.calls[0] as any[])[1].body);
    expect(body.locale).toBe("he");
    const projected = (projectionMock.apply.mock.calls[0] as any[])[2];
    expect(projected.find((e: any) => e.metadata.topic === "business_overview")?.title).toBe("סקירת העסק");
    // Pages carry their own titles.
    expect(projected.find((e: any) => e.metadata.sourceUrl === "https://shop.example.com/faq")?.title).toBe("FAQ");
  });

  it("no workspace language: the request's, else English", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ defaultLocale: null });
    crawlMock.mockResolvedValue(SITE);
    const fetchFn = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", locale: "he", fetchWithTimeoutFn: fetchFn });
    expect(JSON.parse((fetchFn.mock.calls[0] as any[])[1].body).locale).toBe("he");
  });

  it("★ topics left out are reported in the run's knowledge (skipped)", async () => {
    crawlMock.mockResolvedValue(SITE);
    const outcome: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect(Array.isArray(outcome.knowledge.skipped)).toBe(true);
    expect(outcome.knowledge.skipped.length).toBeGreaterThan(0);
    expect(outcome.knowledge.skipped[0]).toEqual({ topic: expect.any(String), reason: expect.stringMatching(/empty|thin/) });
  });
});

describe("★ a site that reads the same is not rescanned (2026-10-14)", () => {
  // Every rescan rewrote the description in fresh model wording, which reset
  // an employee's readiness questions even with the site unchanged.
  const SITE = {
    pages: [{ url: "https://shop.example.com", text: "HALVO clothing" }, { url: "https://shop.example.com/faq", text: "FAQ text" }],
    okPages: [{ url: "https://shop.example.com/faq", text: "FAQ text" }],
    home: { html: "", text: "HALVO clothing" }, signals: {}, businessType: "ecommerce", requested: ["u"], distinctTextPages: 2,
  };

  it("★ second scan of the same text: no model call, no writes, unchanged", async () => {
    crawlMock.mockResolvedValue(SITE);
    const first = okFetch();
    const a: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: first });
    expect(a.ok).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(settings.store[SCAN_CHECKSUM_KEY]!))).toEqual(SITE.pages.map((p) => p.url));
    vi.clearAllMocks();
    const second = okFetch();
    const b: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: second });
    expect(b).toMatchObject({ ok: true, unchanged: true, applied: [] });
    expect(second).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
    expect(projectionMock.apply).not.toHaveBeenCalled();
  });

  it("the site changed, or force: a full scan", async () => {
    crawlMock.mockResolvedValue(SITE);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    const forced = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", force: true, fetchWithTimeoutFn: forced });
    expect(forced).toHaveBeenCalledTimes(1);
    crawlMock.mockResolvedValue({ ...SITE, pages: [...SITE.pages, { url: "https://shop.example.com/new", text: "New page" }] });
    const changed = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: changed });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a failed scan does not remember the checksum (the next one runs in full)", async () => {
    crawlMock.mockResolvedValue(SITE);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) }) as any);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });
    expect(settings.store[SCAN_CHECKSUM_KEY]).toBeUndefined();
  });

  it("the background run reports unchanged", async () => {
    crawlMock.mockResolvedValue(SITE);
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    await startProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    await new Promise((r) => setTimeout(r, 10));
    expect(await readScanRun("t1")).toMatchObject({ status: "done", unchanged: true });
  });
});

describe("★ a page that only failed to answer is not a change (2026-10-14)", () => {
  // Measured on the demo store: one or two pages per crawl answered past the
  // timeout, so the page set changed every run, every rescan ran in full, and
  // the timed-out page's knowledge was removed until the next run.
  const page = (url: string, text: string) => ({ url: `https://shop.example.com${url}`, text });
  const PAGES = [page("", "HALVO clothing"), page("/faq", "FAQ text"), page("/shipping", "Ships in 3 days")];
  const site = (pages: any[], unreadable: string[] = []) => ({
    pages, okPages: pages.slice(1), home: { html: "", text: "HALVO clothing" }, signals: {}, businessType: "ecommerce",
    requested: pages.map((p: any) => p.url), distinctTextPages: pages.length, unreadable,
  });
  const baseline = async () => {
    crawlMock.mockResolvedValue(site(PAGES));
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    vi.clearAllMocks();
  };

  it("★ a page unreadable this time: unchanged, no model call", async () => {
    await baseline();
    crawlMock.mockResolvedValue(site(PAGES.slice(0, 2), [PAGES[2]!.url]));
    const fetchFn = okFetch();
    const r: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: fetchFn });
    expect(r).toMatchObject({ ok: true, unchanged: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("★ a page GONE (not read, not unreadable) is a change", async () => {
    await baseline();
    crawlMock.mockResolvedValue(site(PAGES.slice(0, 2)));
    const fetchFn = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("one page's text changed: a change, and only that page is named in the log", async () => {
    await baseline();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    crawlMock.mockResolvedValue(site([PAGES[0], PAGES[1], page("/shipping", "Ships in 5 days")]));
    const fetchFn = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("full scan"))).toContain("changed: https://shop.example.com/shipping)");
    log.mockRestore();
  });

  it("★ a full run with a page unreadable keeps its document and its remembered hash", async () => {
    await baseline();
    // The site changed elsewhere, so this run is full, and /shipping timed out.
    crawlMock.mockResolvedValue(site([PAGES[0], page("/faq", "FAQ text, edited")], [PAGES[2]!.url]));
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });
    expect((projectionMock.apply.mock.calls[0] as any[])[3].keepUrls).toEqual([PAGES[2]!.url]);
    expect(Object.keys(JSON.parse(settings.store[SCAN_CHECKSUM_KEY]!))).toContain(PAGES[2]!.url);
    // So /shipping answering again next time, unchanged, is not a change.
    vi.clearAllMocks();
    crawlMock.mockResolvedValue(site([PAGES[0], page("/faq", "FAQ text, edited"), PAGES[2]]));
    const fetchFn = okFetch();
    expect(await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: fetchFn })).toMatchObject({ unchanged: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("★ the old single-hash value is no baseline: one full run, then unchanged", async () => {
    settings.store[SCAN_CHECKSUM_KEY] = "b764984463878a89".repeat(4);
    crawlMock.mockResolvedValue(site(PAGES));
    const a = okFetch();
    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: a });
    expect(a).toHaveBeenCalledTimes(1);
    const b = okFetch();
    expect(await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: b })).toMatchObject({ unchanged: true });
    expect(b).not.toHaveBeenCalled();
  });
});

describe("★ a topic is retired only when two full scans in a row found it thin (2026-10-14)", () => {
  // Contact channels named but none usable: contact_hours is "thin".
  const THIN = { ...REPORT, communication: { channels: [{ type: "phone" }] } };
  const RICH = { ...REPORT, communication: { channels: [{ type: "phone", identifier: "03-555-1234" }] } };
  const SITE = (n: number) => ({
    pages: [{ url: "https://shop.example.com", text: `HALVO ${n}` }], okPages: [], home: { html: "", text: `HALVO ${n}` },
    signals: {}, businessType: "ecommerce", requested: ["u"], distinctTextPages: 1, unreadable: [],
  });
  const run = async (n: number, report: unknown) => {
    crawlMock.mockResolvedValue(SITE(n));
    projectionMock.apply.mockClear();
    const r: any = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch(report) });
    return { thin: r.knowledge.skipped.filter((t: any) => t.reason === "thin").map((t: any) => t.topic), retire: (projectionMock.apply.mock.calls[0] as any[])[3].retireTopics };
  };

  it("★ thin once: kept; thin again: retired", async () => {
    const a = await run(1, THIN);
    expect(a.thin).toContain("contact_hours");
    expect(a.retire).toEqual([]);
    const b = await run(2, THIN);
    expect(b.retire).toContain("contact_hours");
  });

  it("★ thin, then not, then thin: the streak starts over", async () => {
    await run(1, THIN);
    const b = await run(2, RICH);
    expect(b.thin).not.toContain("contact_hours");
    const c = await run(3, THIN);
    expect(c.retire).not.toContain("contact_hours");
    expect(JSON.parse(settings.store[SCAN_THIN_TOPICS_KEY]!)).toContain("contact_hours");
  });
});
