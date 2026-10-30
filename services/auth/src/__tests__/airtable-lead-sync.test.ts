/**
 * Leads the team's Airtable missed reach it later, once, and never over a
 * lead the team already works (2026-10-30: the workspace's monthly API quota
 * ran out the day the landing forms went live).
 *   - found by email: nothing written, the row marked
 *   - missing: written, marked; a second pass writes no duplicate
 *   - a phone-first lead is looked up by phone and written without an email
 *   - the quota error stops the pass and holds the next ones; a plain 429 stops without holding
 *   - one failing lead does not stop the others
 *   - only leads since the forms went live, oldest first
 *   - the signup's own write marks the row when Airtable takes it
 *   - a quote in an email cannot break out of the lookup formula
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.AIRTABLE_LEADS_TOKEN = "pat_test";
  process.env.AIRTABLE_LEADS_BASE_ID = "appTEST";
  process.env.AIRTABLE_LEADS_TABLE_ID = "tblTEST";
});

const H = vi.hoisted(() => ({
  rows: [] as any[],
  findManyArgs: [] as any[],
  redis: new Map<string, string>(),
  airtable: [] as Array<{ email?: string; phone?: string; fields: Record<string, unknown> }>,
  formulas: [] as string[],
  posts: 0,
  /** A queue of forced responses: { status, body } served before the fake table answers. */
  forced: [] as Array<{ status: number; body: string }>,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getRedis: () => ({
      get: async (k: string) => H.redis.get(k) ?? null,
      set: async (k: string, v: string, ...args: any[]) => {
        if (args.includes("NX") && H.redis.has(k)) return null;
        H.redis.set(k, v);
        return "OK";
      },
      del: async (k: string) => (H.redis.delete(k) ? 1 : 0),
    }),
    prisma: {
      waitlistEntry: {
        findMany: async (args: any) => {
          H.findManyArgs.push(args);
          return H.rows
            .filter((r) => r.airtableSyncedAt == null && r.createdAt >= args.where.createdAt.gte)
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, args.take);
        },
        update: async ({ where, data }: any) => Object.assign(H.rows.find((r) => r.id === where.id), data),
      },
    },
  };
});
vi.mock("../services/telegram.service", () => ({ sendTelegramNotification: vi.fn(async () => undefined) }));
vi.mock("../services/whatsapp-alert.service", () => ({ sendWhatsAppAlert: vi.fn(async () => undefined) }));

const EMAIL_FIELD = "fldzaWt13VONYYpJ6";
const PHONE_FIELD = "fldwz2dpeb10qlCoO";

/** Airtable, as far as these calls can tell. */
globalThis.fetch = vi.fn(async (url: any, init: any) => {
  const forced = H.forced.shift();
  if (forced) return new Response(forced.body, { status: forced.status });
  const u = new URL(String(url));
  if ((init?.method ?? "GET") === "GET") {
    const f = u.searchParams.get("filterByFormula") ?? "";
    H.formulas.push(f);
    const hit = H.airtable.find((r) => (r.email && f.includes(`'${r.email.toLowerCase()}'`)) || (r.phone && f.includes(`'${r.phone}'`)));
    return new Response(JSON.stringify({ records: hit ? [{ id: "rec1" }] : [] }), { status: 200 });
  }
  H.posts++;
  const fields = JSON.parse(init.body).records[0].fields;
  H.airtable.push({ email: fields[EMAIL_FIELD] as string | undefined, phone: fields[PHONE_FIELD] as string | undefined, fields });
  return new Response(JSON.stringify({ records: [{ id: "recNew" }] }), { status: 200 });
}) as any;

import { runAirtableLeadSyncPass, SYNC_SINCE } from "../services/airtable-lead-sync.service";
import { notifyNewLead } from "../services/lead-alert.service";

const QUOTA = { status: 429, body: JSON.stringify({ errors: [{ error: "PUBLIC_API_BILLING_LIMIT_EXCEEDED", message: "Monthly API call limit" }] }) };
let n = 0;
const at = (minutes: number) => new Date(SYNC_SINCE.getTime() + minutes * 60_000);
function row(o: Partial<any> = {}) {
  const r = { id: `w${++n}`, firstName: "Dana", email: `dana${n}@shop.co.il`, phone: null, company: "shop.co.il", source: "landing-form", createdAt: at(n), airtableSyncedAt: null, ...o };
  H.rows.push(r);
  return r;
}

beforeEach(() => {
  H.rows = []; H.findManyArgs = []; H.redis.clear(); H.airtable = []; H.formulas = []; H.posts = 0; H.forced = [];
});

describe("the hourly pass", () => {
  it("a lead already in Airtable is not written again; the row is marked", async () => {
    const r = row();
    H.airtable.push({ email: r.email, fields: {} });
    const out = await runAirtableLeadSyncPass();
    expect(out).toMatchObject({ ran: true, synced: 1 });
    expect(H.posts).toBe(0);
    expect(r.airtableSyncedAt).toBeInstanceOf(Date);
  });

  it("a missing lead is written and marked, and a second pass writes no duplicate", async () => {
    const r = row();
    await runAirtableLeadSyncPass();
    expect(H.posts).toBe(1);
    expect(r.airtableSyncedAt).toBeInstanceOf(Date);
    // The write landed but the mark was lost: the next pass finds it instead of writing it twice.
    r.airtableSyncedAt = null;
    await runAirtableLeadSyncPass();
    expect(H.posts).toBe(1);
    expect(H.airtable).toHaveLength(1);
  });

  it("a phone-first lead is looked up by phone and written without an email", async () => {
    row({ email: "lead-0525401686@no-email.gotcha", phone: "052-540-1686" });
    await runAirtableLeadSyncPass();
    expect(H.formulas[0]).toContain("'052-540-1686'");
    expect(H.formulas[0]).not.toContain("no-email.gotcha");
    expect(H.airtable[0].fields).not.toHaveProperty(EMAIL_FIELD);
    expect(H.airtable[0].phone).toBe("052-540-1686");
  });

  it("the quota error stops the pass, nothing is written or marked, and the next pass is held", async () => {
    const a = row();
    const b = row();
    H.forced.push(QUOTA);
    const out = await runAirtableLeadSyncPass();
    expect(out).toMatchObject({ ran: true, synced: 0, stopped: "quota" });
    expect(H.posts).toBe(0);
    expect([a.airtableSyncedAt, b.airtableSyncedAt]).toEqual([null, null]);
    expect(await runAirtableLeadSyncPass()).toMatchObject({ ran: false });
    expect(H.findManyArgs).toHaveLength(1);
  });

  it("a plain 429 stops the pass without holding the next one", async () => {
    row();
    H.forced.push({ status: 429, body: JSON.stringify({ errors: [{ error: "RATE_LIMIT_REACHED" }] }) });
    expect(await runAirtableLeadSyncPass()).toMatchObject({ stopped: "rate_limit", synced: 0 });
    expect(await runAirtableLeadSyncPass()).toMatchObject({ ran: true, synced: 1 });
  });

  it("one failing lead does not stop the others", async () => {
    const a = row();
    const b = row();
    H.forced.push({ status: 422, body: "INVALID_VALUE_FOR_COLUMN" });
    const out = await runAirtableLeadSyncPass();
    expect(out).toMatchObject({ synced: 1, failed: 1 });
    expect(a.airtableSyncedAt).toBeNull();
    expect(b.airtableSyncedAt).toBeInstanceOf(Date);
  });

  it("only leads since the forms went live, oldest first", async () => {
    const old = row({ createdAt: new Date(SYNC_SINCE.getTime() - 60_000) });
    const later = row({ createdAt: at(30) });
    const first = row({ createdAt: at(1) });
    await runAirtableLeadSyncPass();
    expect(H.findManyArgs[0].where.createdAt.gte).toEqual(SYNC_SINCE);
    expect(H.findManyArgs[0].orderBy).toEqual({ createdAt: "asc" });
    expect(old.airtableSyncedAt).toBeNull();
    expect(H.airtable.map((r) => r.email)).toEqual([first.email, later.email]);
  });

  it("a second pass while one runs does nothing", async () => {
    H.redis.set("airtable-lead-sync:lock", "1");
    row();
    expect(await runAirtableLeadSyncPass()).toMatchObject({ ran: false });
    expect(H.posts).toBe(0);
  });

  it("a quote in an email cannot break out of the formula", async () => {
    row({ email: "o'brien@x.co" });
    await runAirtableLeadSyncPass();
    expect(H.formulas[0]).toBe("LOWER({אימייל})='o\\'brien@x.co'");
  });
});

describe("the signup's own write", () => {
  const LEAD = { firstName: "Dana", email: "dana@shop.co.il", phone: null, website: "shop.co.il", source: "landing-form", createdAt: new Date() };

  it("marks the row when Airtable takes it", async () => {
    const r = row();
    await notifyNewLead({ ...LEAD, waitlistEntryId: r.id });
    expect(H.posts).toBe(1);
    expect(r.airtableSyncedAt).toBeInstanceOf(Date);
  });

  it("leaves it for the pass when Airtable refuses", async () => {
    const r = row();
    H.forced.push(QUOTA);
    await notifyNewLead({ ...LEAD, waitlistEntryId: r.id });
    expect(r.airtableSyncedAt).toBeNull();
  });
});
