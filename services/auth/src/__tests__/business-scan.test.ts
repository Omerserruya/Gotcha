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
  businessProfile: { findUnique: vi.fn<(...a: any[]) => any>(), update: vi.fn<(...a: any[]) => any>() },
  businessDiscovery: { findUnique: vi.fn<(...a: any[]) => any>(), updateMany: vi.fn<(...a: any[]) => any>() },
}));
const crawlMock = vi.hoisted(() => vi.fn<(...a: any[]) => any>());
const provenanceMock = vi.hoisted(() => ({
  readProvenance: vi.fn<(...a: any[]) => any>(),
  stampProvenance: vi.fn<(...a: any[]) => any>(),
}));

const settings = vi.hoisted(() => ({ store: {} as Record<string, string>, writes: [] as string[] }));
vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  readDurableSetting: async (_t: string, k: string) => settings.store[k] ?? null,
  writeDurableSetting: async (_t: string, k: string, v: string) => { settings.store[k] = v; settings.writes.push(k); },
}));
vi.mock("../services/site-crawl.service", () => ({ crawlSite: crawlMock }));
vi.mock("../services/field-provenance.service", async () => {
  // The RULE is not mocked - planRescan is the thing under test here, and a
  // stubbed rule would make every assertion below describe the stub.
  const real = await vi.importActual<typeof import("../services/field-provenance.service")>(
    "../services/field-provenance.service",
  );
  return { ...real, readProvenance: provenanceMock.readProvenance, stampProvenance: provenanceMock.stampProvenance };
});

import { mapReportToProfileFields, runProfileRescan, acceptScanProposal, SCAN_PROPOSAL_KEY } from "../services/business-scan.service";

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
  prismaMock.businessDiscovery.findUnique.mockResolvedValue(null);
  prismaMock.businessDiscovery.updateMany.mockResolvedValue({ count: 1 });
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

    expect(prismaMock.businessDiscovery.updateMany).toHaveBeenCalledTimes(1);
    const written = (prismaMock.businessDiscovery.updateMany.mock.calls[0] as any[])[0];
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
    expect(prismaMock.businessDiscovery.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not record anything when the site could not be read at all", async () => {
    crawlMock.mockResolvedValue(null);

    await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: okFetch() });

    // Nothing was read, so there is no measurement. Writing zeros would claim
    // one that never happened - the same reason the column has no default.
    expect(prismaMock.businessDiscovery.updateMany).not.toHaveBeenCalled();
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
