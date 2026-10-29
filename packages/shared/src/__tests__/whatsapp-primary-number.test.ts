/**
 * The tenant's primary WhatsApp number (2026-10-29). With two WABAs, the
 * senders that no conversation owns (unbound templates, approvals, carts,
 * unbound voice templates) used to take whichever row came first.
 *   - the chosen number while it is active, re-checked under the caller's filters
 *   - else the first CONNECTED by connectedAt, else the first active, else none
 *   - choosing checks the tenant and that the number can send; null clears
 *   - removing the chosen number drops the choice and names the next one
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ settings: new Map<string, string>(), rows: [] as any[], prismaCalls: 0 }));

vi.mock("../lib/durable-settings", () => ({
  readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
  writeDurableSetting: async (t: string, k: string, v: string | null) => {
    if (v === null) H.settings.delete(`${t}:${k}`);
    else H.settings.set(`${t}:${k}`, v);
  },
}));
vi.mock("../lib/prisma", () => ({ prisma: { channelAccount: { findFirst: async () => { H.prismaCalls++; return null; } } } }));

import {
  resolvePrimaryWhatsAppAccount,
  primaryWhatsAppState,
  setPrimaryWhatsAppAccount,
  releasePrimaryIfRemoved,
  PrimaryNumberError,
  WHATSAPP_PRIMARY_SETTING,
} from "../whatsapp/primary-number";

/** A findFirst that honours every equality in `where` and orders by connectedAt (nulls last), createdAt, id. */
const db = {
  channelAccount: {
    findFirst: async (a: any) => {
      const hits = H.rows.filter((r) => Object.entries(a.where).every(([k, v]) => r[k] === v));
      if (a.orderBy) {
        const t = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);
        hits.sort((x, y) => t(x.connectedAt) - t(y.connectedAt) || x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));
      }
      const r = hits[0];
      if (!r) return null;
      return a.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]])) : r;
    },
  },
};

const at = (d: number) => new Date(Date.UTC(2026, 9, d));
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: "T", channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED",
  connectedAt: at(10), createdAt: at(1), externalId: `pn_${id}`, ...o,
});
const choose = (id: string) => H.settings.set(`T:${WHATSAPP_PRIMARY_SETTING}`, JSON.stringify(id));

beforeEach(() => {
  H.settings.clear();
  H.prismaCalls = 0;
  // b connected first even though a was created first; c belongs to another tenant.
  H.rows = [
    row("a", { connectedAt: at(12), createdAt: at(1) }),
    row("b", { connectedAt: at(11), createdAt: at(2) }),
    row("c", { tenantId: "OTHER", connectedAt: at(1) }),
  ];
});

describe("the default: first connected by connectedAt", () => {
  it("picks by connectedAt, not createdAt, and never another tenant's", async () => {
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: "b", source: "default" });
  });
  it("prefers CONNECTED over an earlier PENDING number", async () => {
    H.rows.push(row("p", { connectionStatus: "PENDING", connectedAt: at(2) }));
    expect((await primaryWhatsAppState("T", db)).channelAccountId).toBe("b");
  });
  it("falls back to an active non-CONNECTED number when none is CONNECTED", async () => {
    H.rows = [row("p", { connectionStatus: "PENDING" })];
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: "p", source: "default" });
  });
  it("no active number: none", async () => {
    H.rows = [row("x", { isActive: false })];
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: null, source: "none" });
  });
});

describe("the chosen number", () => {
  it("wins while active", async () => {
    choose("a");
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: "a", source: "chosen" });
  });
  it("a disconnected choice is skipped for the default", async () => {
    choose("a");
    H.rows[0].isActive = false;
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: "b", source: "default" });
  });
  it("another tenant's id stored as the choice is never used", async () => {
    choose("c");
    expect(await primaryWhatsAppState("T", db)).toEqual({ channelAccountId: "b", source: "default" });
  });
  it("is re-checked under the caller's filters (templates need CONNECTED)", async () => {
    choose("a");
    H.rows[0].connectionStatus = "PENDING";
    const { account, source } = await resolvePrimaryWhatsAppAccount("T", { where: { connectionStatus: "CONNECTED" }, db });
    expect([account.id, source]).toEqual(["b", "default"]);
  });
  it("select is applied to the returned row", async () => {
    const { account } = await resolvePrimaryWhatsAppAccount("T", { select: { id: true, externalId: true }, db });
    expect(account).toEqual({ id: "b", externalId: "pn_b" });
  });
  it("without a db it reads shared's own prisma", async () => {
    await resolvePrimaryWhatsAppAccount("T");
    expect(H.prismaCalls).toBeGreaterThan(0);
  });
});

describe("setting it", () => {
  it("stores a valid choice and answers with the new state", async () => {
    expect(await setPrimaryWhatsAppAccount("T", "a", "u1", db)).toEqual({ channelAccountId: "a", source: "chosen" });
    expect(JSON.parse(H.settings.get(`T:${WHATSAPP_PRIMARY_SETTING}`)!)).toBe("a");
  });
  it("null clears it, back to the default", async () => {
    choose("a");
    expect(await setPrimaryWhatsAppAccount("T", null, "u1", db)).toEqual({ channelAccountId: "b", source: "default" });
    expect(H.settings.has(`T:${WHATSAPP_PRIMARY_SETTING}`)).toBe(false);
  });
  it.each([
    ["another tenant's number", "c", "WHATSAPP_NUMBER_NOT_FOUND", 404],
    ["an unknown id", "zzz", "WHATSAPP_NUMBER_NOT_FOUND", 404],
  ])("refuses %s", async (_n, id, code, status) => {
    const err = await setPrimaryWhatsAppAccount("T", id, "u1", db).catch((e) => e);
    expect(err).toBeInstanceOf(PrimaryNumberError);
    expect([err.code, err.status]).toEqual([code, status]);
    expect(H.settings.size).toBe(0);
  });
  it.each([
    ["inactive", { isActive: false }],
    ["DISCONNECTED", { connectionStatus: "DISCONNECTED" }],
  ])("refuses a number that cannot send (%s)", async (_n, o) => {
    Object.assign(H.rows[0], o);
    const err = await setPrimaryWhatsAppAccount("T", "a", "u1", db).catch((e) => e);
    expect([err.code, err.status]).toEqual(["WHATSAPP_NUMBER_NOT_ACTIVE", 409]);
    expect(H.settings.size).toBe(0);
  });
});

describe("removing a number", () => {
  it("removing the chosen one drops the choice and names the next by connectedAt", async () => {
    choose("b");
    H.rows = H.rows.filter((r) => r.id !== "b");
    expect(await releasePrimaryIfRemoved("T", "b", db)).toEqual({ channelAccountId: "a", source: "default" });
    expect(H.settings.size).toBe(0);
  });
  it("removing another number keeps the choice", async () => {
    choose("a");
    H.rows = H.rows.filter((r) => r.id !== "b");
    expect(await releasePrimaryIfRemoved("T", "b", db)).toEqual({ channelAccountId: "a", source: "chosen" });
  });
  it("removing the last one: none", async () => {
    H.rows = [];
    expect(await releasePrimaryIfRemoved("T", "a", db)).toEqual({ channelAccountId: null, source: "none" });
  });
});
