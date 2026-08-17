import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../lib/prisma", () => ({ prisma: { inboundExclusion: { findFirst } } }));

import { normalizeExclusionValue, exclusionDisplayValue, isInboundExcluded } from "../lib/inbound-exclusions";

/**
 * Numbers the owner keeps on their own phone.
 *
 * Two failure directions, and they are not symmetric. Letting an excluded
 * number through puts a private conversation in a shared inbox - visible, and
 * the owner can delete it. Excluding the wrong number silently drops a real
 * customer, and nobody finds out. The matching rules below are chosen with
 * that asymmetry in mind.
 */

describe("normalizeExclusionValue", () => {
  it("matches the same number however it was written", () => {
    // WhatsApp reports `972541111111`; a person types any of these.
    const forms = ["972541111111", "+972541111111", "+972-54-111-1111", "972 54 111 1111", "(972) 54 111 1111"];
    const normalized = forms.map(normalizeExclusionValue);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("972541111111");
  });

  it("keeps leading zeros instead of guessing a country code", () => {
    // `0541111111` and `972541111111` are the same human, but turning one into
    // the other needs a country we do not reliably know here. Guessing wrong
    // excludes a DIFFERENT customer - the silent failure.
    expect(normalizeExclusionValue("054-111-1111")).toBe("0541111111");
    expect(normalizeExclusionValue("054-111-1111")).not.toBe(normalizeExclusionValue("+972541111111"));
  });

  it("survives empty and junk input", () => {
    expect(normalizeExclusionValue("")).toBe("");
    expect(normalizeExclusionValue("abc")).toBe("");
    expect(normalizeExclusionValue(undefined as any)).toBe("");
  });
});

describe("exclusionDisplayValue", () => {
  it("keeps what the owner typed, so it does not look mangled back at them", () => {
    expect(exclusionDisplayValue("+972-54-111-1111")).toBe("+972-54-111-1111");
  });

  it("falls back to the digits when there is nothing readable", () => {
    expect(exclusionDisplayValue("   ")).toBe("");
  });
});

describe("isInboundExcluded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(null);
  });

  it("queries on the normalized digits, not the raw channel value", async () => {
    await isInboundExcluded({ tenantId: "t1", channel: "WHATSAPP", customerExternalId: "+972-54-111-1111" });

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ customerExternalId: "972541111111" }),
    }));
  });

  it("matches an account-wide rule and a rule scoped to this number", async () => {
    await isInboundExcluded({ tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972541111111", channelAccountId: "ca1" });

    const where = findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ channelAccountId: null }, { channelAccountId: "ca1" }]);
  });

  it("never matches a rule scoped to a DIFFERENT number on the same tenant", async () => {
    // A tenant with two WhatsApp numbers excludes their accountant on the one
    // that runs in the app. The other number must keep receiving them.
    await isInboundExcluded({ tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972541111111" });

    const where = findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ channelAccountId: null }]);
  });

  it("returns true when a rule exists", async () => {
    findFirst.mockResolvedValue({ id: "rule1" });
    await expect(isInboundExcluded({ tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972541111111" })).resolves.toBe(true);
  });

  it("fails OPEN on an unusable sender id", async () => {
    // No digits means nothing can be matched. Admitting the message is the
    // recoverable direction; treating "no match possible" as "excluded" would
    // drop real traffic invisibly.
    await expect(isInboundExcluded({ tenantId: "t1", channel: "WHATSAPP", customerExternalId: "" })).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("is scoped per tenant and per channel", async () => {
    await isInboundExcluded({ tenantId: "t1", channel: "INSTAGRAM", customerExternalId: "972541111111" });

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "t1", channel: "INSTAGRAM" }),
    }));
  });
});
