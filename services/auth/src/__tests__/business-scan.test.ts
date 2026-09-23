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
  businessDiscovery: { findUnique: vi.fn<(...a: any[]) => any>() },
}));
const crawlMock = vi.hoisted(() => vi.fn<(...a: any[]) => any>());
const provenanceMock = vi.hoisted(() => ({
  readProvenance: vi.fn<(...a: any[]) => any>(),
  stampProvenance: vi.fn<(...a: any[]) => any>(),
}));

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));
vi.mock("../services/site-crawl.service", () => ({ crawlSite: crawlMock }));
vi.mock("../services/field-provenance.service", async () => {
  // The RULE is not mocked - planRescan is the thing under test here, and a
  // stubbed rule would make every assertion below describe the stub.
  const real = await vi.importActual<typeof import("../services/field-provenance.service")>(
    "../services/field-provenance.service",
  );
  return { ...real, readProvenance: provenanceMock.readProvenance, stampProvenance: provenanceMock.stampProvenance };
});

import { mapReportToProfileFields, runProfileRescan } from "../services/business-scan.service";

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
  prismaMock.businessProfile.findUnique.mockResolvedValue({ ...PROFILE });
  prismaMock.businessProfile.update.mockResolvedValue({});
  prismaMock.businessDiscovery.findUnique.mockResolvedValue(null);
  provenanceMock.readProvenance.mockResolvedValue({});
  crawlMock.mockResolvedValue({ pages: [], signals: {}, businessType: "ecommerce" });
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

  it("writes nothing when the model is unavailable", async () => {
    // The live case on this stack: the tenant is out of AI units.
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as any);

    const outcome = await runProfileRescan({ tenantId: "t1", authHeader: "Bearer x", fetchWithTimeoutFn: failing });

    expect(outcome).toEqual({ ok: false, reason: "scan_failed" });
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });
});
