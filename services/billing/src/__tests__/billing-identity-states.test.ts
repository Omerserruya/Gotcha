/**
 * Three different facts must not produce the same response.
 *
 * `GET /billing/profile` returned a byte-identical all-null body for:
 *   • a tenant with no billable entity at all
 *   • an entity whose billing profile has never been created
 *   • a profile that exists and whose fields were emptied
 *
 * So the screen could only render one sentence for all three, and rendering
 * "nothing has been filled in" at somebody whose details were DELETED tells
 * them they never had any. The first state is also the one where "add your
 * billing details" is not even the right instruction, because there is nothing
 * to add them to.
 *
 * The values are unchanged - the caller that issues documents against this
 * identity reads them and has no opinion about which state produced them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  billableEntityTenant: { findUnique: vi.fn<(...a: any[]) => any>() },
  billingProfile: { findUnique: vi.fn<(...a: any[]) => any>() },
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return { ...actual, prisma: prismaMock };
});

import { billingIdentity } from "../routes/payment-methods";

const FIELDS = ["billingName", "vatId", "billingEmail", "billingCountry", "billingAddress"] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the three states are distinguishable", () => {
  it("no billable entity at all", async () => {
    prismaMock.billableEntityTenant.findUnique.mockResolvedValue(null);

    const id = await billingIdentity("t1");

    expect(id.state).toBe("no_billable_entity");
    // Never reaches the profile table - there is no entity to look one up by.
    expect(prismaMock.billingProfile.findUnique).not.toHaveBeenCalled();
  });

  it("an entity whose profile has never been created", async () => {
    prismaMock.billableEntityTenant.findUnique.mockResolvedValue({ billableEntityId: "be1" });
    prismaMock.billingProfile.findUnique.mockResolvedValue(null);

    const id = await billingIdentity("t1");

    expect(id.state).toBe("no_billing_profile");
  });

  it("★ a profile that exists and was EMPTIED reads differently from one that never existed", async () => {
    prismaMock.billableEntityTenant.findUnique.mockResolvedValue({ billableEntityId: "be1" });
    prismaMock.billingProfile.findUnique.mockResolvedValue(
      Object.fromEntries(FIELDS.map((f) => [f, null])),
    );

    const id = await billingIdentity("t1");

    // Same null values as the case above, different fact. This is the whole
    // point: the fields cannot tell these apart, so the state has to.
    expect(id.state).toBe("present");
    for (const f of FIELDS) expect(id[f]).toBeNull();
  });

  it("returns all three distinct state values across the three shapes", async () => {
    const seen: string[] = [];

    prismaMock.billableEntityTenant.findUnique.mockResolvedValue(null);
    seen.push((await billingIdentity("t1")).state);

    prismaMock.billableEntityTenant.findUnique.mockResolvedValue({ billableEntityId: "be1" });
    prismaMock.billingProfile.findUnique.mockResolvedValue(null);
    seen.push((await billingIdentity("t1")).state);

    prismaMock.billingProfile.findUnique.mockResolvedValue(
      Object.fromEntries(FIELDS.map((f) => [f, null])),
    );
    seen.push((await billingIdentity("t1")).state);

    // The regression this guards: any two of them collapsing back into one.
    expect(new Set(seen).size).toBe(3);
  });
});

describe("the values the document caller reads are unchanged", () => {
  it("passes a filled profile straight through", async () => {
    prismaMock.billableEntityTenant.findUnique.mockResolvedValue({ billableEntityId: "be1" });
    prismaMock.billingProfile.findUnique.mockResolvedValue({
      billingName: "Urban Supply Ltd",
      vatId: "512345678",
      billingEmail: "billing@example.com",
      billingCountry: "IL",
      billingAddress: "1 Example St, Tel Aviv",
    });

    const id = await billingIdentity("t1");

    expect(id.billingName).toBe("Urban Supply Ltd");
    expect(id.vatId).toBe("512345678");
    expect(id.billingCountry).toBe("IL");
    expect(id.state).toBe("present");
  });

  it("carries every field in all three states, so a caller never has to guard for a missing key", async () => {
    prismaMock.billableEntityTenant.findUnique.mockResolvedValue(null);

    const id = await billingIdentity("t1");

    // The tokenization caller reads identity.billingName ?? undefined and so on.
    // A state that omitted the keys would make that read undefined-by-absence
    // rather than by value, which is the same collapse one level down.
    for (const f of FIELDS) expect(f in id).toBe(true);
  });
});
