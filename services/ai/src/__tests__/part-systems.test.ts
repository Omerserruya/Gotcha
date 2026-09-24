/**
 * Which system serves each part, as the AI reads it.
 *
 * The thing this guards is not the happy path. It is that an UNMAPPED part stays
 * unmapped: it must never resolve to "whatever integration happens to be
 * connected", because guessing is the behaviour screen 14 exists to replace, and
 * a caller handed a guess cannot tell it from a merchant's choice.
 *
 * It is also a FACADE, not a new elector. Two parts already had one before this
 * screen - the CRM resolver and the returns resolver - each with storage the AI
 * already reads. These tests pin the delegation, because a second switch for
 * either is how a merchant's setting gets ignored in favour of the other one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ tenantIntegration: { findMany: vi.fn<(...a: any[]) => any>() } }));
const crmMock = vi.hoisted(() => ({ resolveCrmVendor: vi.fn<(...a: any[]) => any>() }));
const returnsMock = vi.hoisted(() => ({ getReturnProvider: vi.fn<(...a: any[]) => any>() }));

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));
vi.mock("../services/connectors/crm-adapter-resolver", () => crmMock);
vi.mock("../services/return-provider.service", () => returnsMock);

import { getSystemForPart, getBusinessCoreMap, renderBusinessCoreBlock } from "../services/connectors/part-systems";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.tenantIntegration.findMany.mockResolvedValue([]);
  crmMock.resolveCrmVendor.mockResolvedValue(null);
  returnsMock.getReturnProvider.mockResolvedValue({ provider: "none", reason: "nothing can create a return" });
});

describe("an unmapped part stays unmapped", () => {
  it("★ does NOT fall through to whatever is connected", async () => {
    // Shopify is connected and could serve ecommerce, but nobody chose it.
    prismaMock.tenantIntegration.findMany.mockResolvedValue([
      { config: {}, integration: { slug: "shopify" } },
    ]);

    const result = await getSystemForPart("t1", "ecommerce");

    // The guess would be "shopify" and it would be indistinguishable from a
    // choice. This is the whole point of the mechanism.
    expect(result.slug).toBeNull();
    expect(result.source).toBe("unmapped");
    expect(result.reason).toMatch(/No system has been chosen/);
  });

  it("resolves a part that WAS chosen", async () => {
    prismaMock.tenantIntegration.findMany.mockResolvedValue([
      { config: { roles: ["ecommerce"] }, integration: { slug: "shopify" } },
    ]);

    const result = await getSystemForPart("t1", "ecommerce");

    expect(result).toMatchObject({ slug: "shopify", source: "elected" });
  });

  it("only counts CONNECTED integrations, which the query enforces", async () => {
    await getSystemForPart("t1", "payments");

    expect(prismaMock.tenantIntegration.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: "t1",
      status: "CONNECTED",
    });
  });

  it("reports a part nothing can serve as unavailable, not unmapped", async () => {
    const result = await getSystemForPart("t1", "shipping");

    // Different sentences: "nothing exists to choose" versus "nobody chose".
    expect(result.source).toBe("unavailable");
    expect(result.reason).toMatch(/No shipping integration exists/);
  });

  it("degrades to unmapped rather than throwing", async () => {
    prismaMock.tenantIntegration.findMany.mockRejectedValue(new Error("db gone"));

    const result = await getSystemForPart("t1", "ecommerce");

    // A resolution failure must not take down a reply.
    expect(result.source).toBe("unmapped");
    expect(result.slug).toBeNull();
  });
});

describe("it delegates rather than deciding", () => {
  it("★ asks the CRM resolver for the crm part, and never config.roles", async () => {
    crmMock.resolveCrmVendor.mockResolvedValue("hubspot");
    prismaMock.tenantIntegration.findMany.mockResolvedValue([
      { config: { roles: ["crm"] }, integration: { slug: "shopify" } },
    ]);

    const result = await getSystemForPart("t1", "crm");

    // A `roles: ["crm"]` value must NOT win over the real elector - that is the
    // two-sources shape, and the CRM resolver is what the bot actually calls.
    expect(result.slug).toBe("hubspot");
    expect(crmMock.resolveCrmVendor).toHaveBeenCalledWith("t1");
  });

  it("★ asks the returns resolver for the returns part", async () => {
    returnsMock.getReturnProvider.mockResolvedValue({ provider: "returngo", reason: "explicit selection" });

    const result = await getSystemForPart("t1", "returns");

    expect(result.slug).toBe("returngo");
    expect(result.source).toBe("elected");
  });

  it("labels a capability-first returns answer as INFERRED, not chosen", async () => {
    returnsMock.getReturnProvider.mockResolvedValue({ provider: "shopify", reason: "capability-first precedence" });

    const result = await getSystemForPart("t1", "returns");

    // "Inferred" must not read as a decision somebody made - the merchant did
    // not pick this and a screen has to be able to say so.
    expect(result.source).toBe("inferred");
  });

  it("reports no customer system of record rather than guessing one", async () => {
    const result = await getSystemForPart("t1", "crm");

    expect(result.slug).toBeNull();
    expect(result.source).toBe("unmapped");
  });
});

describe("what the model is told", () => {
  it("★ STATES the unmapped parts instead of omitting them", async () => {
    const block = renderBusinessCoreBlock([
      { part: "ecommerce", slug: "shopify", source: "elected", reason: "" },
      { part: "payments", slug: null, source: "unmapped", reason: "" },
    ]);

    // Listing only the mapped parts lets the model assume the rest are its
    // choice, which is the guess the whole mechanism removes.
    expect(block).toContain("ecommerce: shopify");
    expect(block).toContain("payments: no system chosen");
    expect(block).toContain("Do not assume one");
  });

  it("marks an inferred system as not chosen by the business", async () => {
    const block = renderBusinessCoreBlock([
      { part: "returns", slug: "shopify", source: "inferred", reason: "" },
    ]);

    expect(block).toContain("(inferred, not chosen by the business)");
  });

  it("omits a part nothing can serve, rather than telling the model to ask about it", async () => {
    const block = renderBusinessCoreBlock([
      { part: "shipping", slug: null, source: "unavailable", reason: "" },
      { part: "ecommerce", slug: "shopify", source: "elected", reason: "" },
    ]);

    // There is nothing to choose and nothing for the model to do about it.
    expect(block).not.toContain("shipping");
    expect(block).toContain("ecommerce");
  });

  it("renders nothing at all when every part is unavailable", async () => {
    expect(renderBusinessCoreBlock([{ part: "shipping", slug: null, source: "unavailable", reason: "" }])).toBe("");
    expect(renderBusinessCoreBlock([])).toBe("");
  });

  it("covers every part in the full map", async () => {
    const map = await getBusinessCoreMap("t1");

    expect(map.map((m) => m.part).sort()).toEqual(["crm", "ecommerce", "payments", "returns", "shipping"]);
  });
});
