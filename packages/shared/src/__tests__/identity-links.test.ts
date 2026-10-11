/**
 * Linking contacts as one person: automatic on strong evidence, suggested on
 * weak, always reversible exactly (2026-10-11). The store honours tenantId and
 * the unique (tenantId, key) the real TenantSetting table enforces.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { linkContacts, suggestLink, unlinkContacts, pairKey, IDENTITY_LINK, NOT_SAME_PREFIX } from "../lib/identity-links";

let contacts: any[];
let settings: any[];

const db = {
  contact: {
    findMany: async ({ where }: any) => contacts.filter((c) => c.tenantId === where.tenantId && where.id.in.includes(c.id) && (where.mergedIntoId === undefined || c.mergedIntoId === where.mergedIntoId)).map((c) => ({ ...c })),
    update: async ({ where, data }: any) => { const c = contacts.find((x) => x.id === where.id); Object.assign(c, data); return { ...c }; },
  },
  tenantSetting: {
    findFirst: async ({ where }: any) => settings.find((s) => s.tenantId === where.tenantId && s.key === where.key) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const s = settings.find((x) => x.tenantId === where.tenantId_key.tenantId && x.key === where.tenantId_key.key);
      if (s) { Object.assign(s, update); return s; }
      settings.push({ ...create }); return create;
    },
  },
  $transaction: async (fn: any) => fn(db),
};

beforeEach(() => {
  contacts = [
    { id: "ig", tenantId: "t1", personId: "person_ig", mergedIntoId: null },
    { id: "wa", tenantId: "t1", personId: "person_wa", mergedIntoId: null },
    { id: "wa2", tenantId: "t1", personId: "person_wa", mergedIntoId: null }, // already the same person as wa
    { id: "other", tenantId: "t2", personId: "person_x", mergedIntoId: null },
    { id: "bare", tenantId: "t1", personId: null, mergedIntoId: null },
  ];
  settings = [];
});

const rec = (a: string, b: string) => settings.find((s) => s.key === pairKey(IDENTITY_LINK, a, b))?.value;

describe("linkContacts", () => {
  it("moves the source onto the target's person, records both previous ids, overwrites nothing else", async () => {
    expect(await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "wa", signal: "shared_identifier", by: "auto:shared_identifier", db })).toBe("linked");
    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_wa");
    expect(contacts.find((c) => c.id === "wa").personId).toBe("person_wa");
    expect(rec("ig", "wa")).toMatchObject({ status: "APPLIED", signal: "shared_identifier", sourceContactId: "ig", previousPersonIds: { ig: "person_ig", wa: "person_wa" } });
  });

  it("a target with no person gets one, shared with the source", async () => {
    await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "bare", signal: "shopify_customer", by: "auto", db });
    const p = contacts.find((c) => c.id === "bare").personId;
    expect(p).toMatch(/^person_/);
    expect(contacts.find((c) => c.id === "ig").personId).toBe(p);
    expect(rec("ig", "bare").previousPersonIds).toEqual({ ig: "person_ig", bare: null });
  });

  it("refuses: another tenant's contact, a pair marked not-same, a pair whose link was undone", async () => {
    expect(await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "other", signal: "shared_identifier", by: "x", db })).toBe("missing");
    settings.push({ tenantId: "t1", key: pairKey(NOT_SAME_PREFIX, "ig", "wa"), value: {} });
    expect(await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "wa", signal: "shared_identifier", by: "x", db })).toBe("not_same");
    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_ig");
  });

  it("already one person: nothing written", async () => {
    expect(await linkContacts({ tenantId: "t1", sourceContactId: "wa", targetContactId: "wa2", signal: "shared_identifier", by: "x", db })).toBe("already_same_person");
    expect(settings).toHaveLength(0);
  });
});

describe("unlinkContacts restores exactly", () => {
  it("each contact gets back its previous person; the pair becomes REJECTED and not-same, and is never linked again", async () => {
    await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "wa", signal: "shared_identifier", by: "auto", db });
    expect(await unlinkContacts({ tenantId: "t1", contactIds: ["wa", "ig"], by: "u1", db })).toBe("unlinked");

    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_ig");
    expect(contacts.find((c) => c.id === "wa").personId).toBe("person_wa");
    expect(contacts.find((c) => c.id === "wa2").personId).toBe("person_wa");
    expect(rec("ig", "wa").status).toBe("REJECTED");
    expect(settings.some((s) => s.key === pairKey(NOT_SAME_PREFIX, "ig", "wa"))).toBe(true);
    expect(await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "wa", signal: "shopify_customer", by: "auto", db })).toBe("not_same");
  });

  it("a target that had no person goes back to none", async () => {
    await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "bare", signal: "shopify_customer", by: "auto", db });
    await unlinkContacts({ tenantId: "t1", contactIds: ["ig", "bare"], by: "u1", db });
    expect(contacts.find((c) => c.id === "bare").personId).toBeNull();
    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_ig");
  });

  it("a contact moved since the link is left where a person put it", async () => {
    await linkContacts({ tenantId: "t1", sourceContactId: "ig", targetContactId: "wa", signal: "shared_identifier", by: "auto", db });
    contacts.find((c) => c.id === "ig").personId = "person_manual";
    await unlinkContacts({ tenantId: "t1", contactIds: ["ig", "wa"], by: "u1", db });
    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_manual");
  });

  it("nothing to undo: not_linked", async () => {
    expect(await unlinkContacts({ tenantId: "t1", contactIds: ["ig", "wa"], by: "u1", db })).toBe("not_linked");
  });
});

describe("suggestLink never links", () => {
  it("records PENDING and leaves both persons alone; a decided or not-same pair is not re-suggested", async () => {
    expect(await suggestLink({ tenantId: "t1", contactIds: ["ig", "wa"], signal: "same_name", by: "auto", db })).toBe("suggested");
    expect(contacts.find((c) => c.id === "ig").personId).toBe("person_ig");
    expect(rec("ig", "wa").status).toBe("PENDING");
    expect(await suggestLink({ tenantId: "t1", contactIds: ["wa", "ig"], signal: "same_name", by: "auto", db })).toBe("exists");
    settings.push({ tenantId: "t1", key: pairKey(NOT_SAME_PREFIX, "ig", "bare"), value: {} });
    expect(await suggestLink({ tenantId: "t1", contactIds: ["ig", "bare"], signal: "same_name", by: "auto", db })).toBe("not_same");
  });
});

describe("the not-same prefix is the conversation service's", () => {
  it("matches services/conversation lib/not-same.ts", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("../../../../services/conversation/src/lib/not-same.ts", import.meta.url), "utf8");
    expect(src).toContain(`export const NOT_SAME = "${NOT_SAME_PREFIX}";`);
  });
});
