/**
 * A card after N days (self sign-up, 2026-11-22).
 *
 * The sweep closes a self-signed-up organization that reached its card day
 * with no card; a stored card opens it again. Everything here runs on a clock
 * passed in and a database held in memory. Nothing talks to a payment
 * provider, and the last block checks that the service could not if it tried.
 *
 * The database stand-in is strict about the one thing that matters most: the
 * status and the mark may only be written through the transaction's own
 * client, and a transaction that throws writes neither.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({
  tenants: new Map<string, { status: string }>(),
  marks: new Map<string, any>(),
  links: new Map<string, string>(),
  subs: new Map<string, { planKey: string }>(),
  cards: new Map<string, string[]>(),
  checkouts: [] as Array<{ tenantId: string; status: string }>,
  onboarding: new Map<string, { completedAt: Date | null }>(),
  audits: [] as any[],
  cache: [] as any[],
  cacheThrows: false,
  markWriteThrowsFor: null as string | null,
  /** Runs once, just before the first transaction: stands in for another writer. */
  beforeTx: null as null | (() => void),
  sweepReads: [] as any[],
  factReads: [] as string[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const outside = (what: string) => async () => { throw new Error(`${what} written outside the transaction`); };
  const reads = {
    tenant: {
      findUnique: async (q: any) => { H.factReads.push(q.where.id); const t = H.tenants.get(q.where.id); return t ? { ...t } : null; },
    },
    tenantSetting: {
      findMany: async (q: any) => {
        H.sweepReads.push(q);
        return [...H.marks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tenantId, value]) => ({ tenantId, value }));
      },
      findUnique: async (q: any) => {
        const { tenantId, key } = q.where.tenantId_key;
        if (key !== actual.SELF_SIGNUP_ORIGIN_KEY) throw new Error(`unexpected key ${key}`);
        return H.marks.has(tenantId) ? { value: H.marks.get(tenantId) } : null;
      },
    },
    billableEntityTenant: {
      findUnique: async (q: any) => (H.links.has(q.where.tenantId) ? { billableEntityId: H.links.get(q.where.tenantId) } : null),
    },
    subscription: { findUnique: async (q: any) => H.subs.get(q.where.billableEntityId) ?? null },
    paymentMethod: {
      findFirst: async (q: any) => {
        const all = H.cards.get(q.where.profile.billableEntityId) ?? [];
        const hit = q.where.status === undefined ? all.length > 0 : all.includes(q.where.status);
        return hit ? { id: "pm_1" } : null;
      },
    },
    pendingCheckout: {
      findFirst: async (q: any) => {
        const hit = H.checkouts.find((c) => (q.where.tenantId === undefined || c.tenantId === q.where.tenantId) && q.where.status.in.includes(c.status));
        return hit ? { id: "co_1" } : null;
      },
    },
    tenantOnboarding: { findUnique: async (q: any) => H.onboarding.get(q.where.tenantId) ?? null },
  };
  const prisma: any = {
    ...reads,
    tenant: { ...reads.tenant, updateMany: outside("the status"), update: outside("the status") },
    tenantSetting: { ...reads.tenantSetting, update: outside("the mark"), upsert: outside("the mark") },
    $transaction: async (fn: any) => {
      if (H.beforeTx) { const run = H.beforeTx; H.beforeTx = null; run(); }
      // Staged, and kept only when the callback returns.
      const tenants = new Map([...H.tenants].map(([k, v]) => [k, { ...v }] as [string, { status: string }]));
      const marks = new Map(H.marks);
      const tx = {
        tenant: {
          updateMany: async (q: any) => {
            const t = tenants.get(q.where.id);
            if (!t || (q.where.status !== undefined && t.status !== q.where.status)) return { count: 0 };
            t.status = q.data.status;
            return { count: 1 };
          },
        },
        tenantSetting: {
          update: async (q: any) => {
            const { tenantId } = q.where.tenantId_key;
            if (H.markWriteThrowsFor === tenantId) throw new Error("the mark's row could not be written");
            marks.set(tenantId, JSON.parse(JSON.stringify(q.data.value)));
          },
        },
      };
      const out = await fn(tx);
      H.tenants = tenants;
      H.marks = marks;
      return out;
    },
  };
  return {
    ...actual,
    prisma,
    writeAudit: async (e: any) => { H.audits.push(e); },
    writeDurableSetting: async (...a: any[]) => {
      if (H.cacheThrows) throw new Error("the cache is away");
      H.cache.push(a);
    },
    readDurableSetting: async () => { throw new Error("the mark is read from the database, never the cache"); },
  };
});
vi.mock("../services/poc.service", () => ({ POC_PLAN_KEY: "poc" }));

import { SELF_SIGNUP_ORIGIN_KEY, parseSelfSignupOrigin, type SelfSignupOrigin } from "@chatcenter/shared";
import { cardVerdict, sweepCardRequired, restoreAfterCard, closedForCard, type CardFacts } from "../services/card-required.service";

const DAY = 86_400_000;
const SIGNED_UP = "2026-11-01T09:30:00.000Z";
/** The card day of a 14-day mark signed on SIGNED_UP: the moment itself. */
const DUE = new Date(Date.parse(SIGNED_UP) + 14 * DAY);
const mark = (over: Partial<SelfSignupOrigin> = {}): SelfSignupOrigin => ({
  at: SIGNED_UP, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000, ...over,
});

/** One organization on its evaluation, no card. */
function org(id: string, status: string, m: any = mark(), o: { plan?: string | null; cards?: string[]; entity?: boolean } = {}): void {
  H.tenants.set(id, { status });
  if (m !== undefined) H.marks.set(id, m);
  if (o.entity === false) return;
  H.links.set(id, `ent_${id}`);
  if (o.plan !== null) H.subs.set(`ent_${id}`, { planKey: o.plan ?? "poc" });
  if (o.cards) H.cards.set(`ent_${id}`, o.cards);
}
const statusOf = (id: string) => H.tenants.get(id)!.status;
const markOf = (id: string) => parseSelfSignupOrigin(H.marks.get(id));

beforeEach(() => {
  H.tenants = new Map(); H.marks = new Map(); H.links = new Map(); H.subs = new Map(); H.cards = new Map();
  H.checkouts = []; H.onboarding = new Map(); H.audits = []; H.cache = []; H.cacheThrows = false;
  H.markWriteThrowsFor = null; H.beforeTx = null; H.sweepReads = []; H.factReads = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("what the facts ask for", () => {
  const facts = (over: Partial<CardFacts> = {}): CardFacts => ({ status: "ACTIVE", hasCard: false, planKey: "poc", ...over });

  it("closes from the card day's own moment, and not one millisecond before it", () => {
    expect(cardVerdict(mark(), facts(), DUE)).toEqual({ act: "block", priorStatus: "ACTIVE" });
    expect(cardVerdict(mark(), facts(), new Date(DUE.getTime() - 1))).toEqual({ act: "leave" });
  });

  it("counts the days of the mark, not today's setting: a 7-day mark is due a week sooner", () => {
    const seven = mark({ cardRequiredAfterDays: 7 });
    expect(cardVerdict(seven, facts(), new Date(Date.parse(SIGNED_UP) + 7 * DAY))).toEqual({ act: "block", priorStatus: "ACTIVE" });
    expect(cardVerdict(mark(), facts(), new Date(Date.parse(SIGNED_UP) + 7 * DAY))).toEqual({ act: "leave" });
  });

  it.each([["ACTIVE"], ["PENDING_ONBOARDING"], ["PENDING_ADMIN_SETUP"]])("remembers %s as the status to put back", (status) => {
    expect(cardVerdict(mark(), facts({ status }), DUE)).toEqual({ act: "block", priorStatus: status });
  });

  it.each([["SUSPENDED"], ["PENDING_PAYMENT"], [null]])("leaves an organization whose status is %s", (status) => {
    expect(cardVerdict(mark(), facts({ status }), DUE)).toEqual({ act: "leave" });
  });

  it("leaves an organization that has a card", () => {
    expect(cardVerdict(mark(), facts({ hasCard: true }), DUE)).toEqual({ act: "leave" });
  });

  it("closes only the evaluation: no subscription row and the evaluation's row close, a plan of its own does not", () => {
    expect(cardVerdict(mark(), facts({ planKey: null }), DUE)).toEqual({ act: "block", priorStatus: "ACTIVE" });
    expect(cardVerdict(mark(), facts({ planKey: "poc" }), DUE)).toEqual({ act: "block", priorStatus: "ACTIVE" });
    expect(cardVerdict(mark(), facts({ planKey: "growth" }), DUE)).toEqual({ act: "leave" });
  });

  it("closes once per mark: an operator who opened a closed organization by hand is not overruled", () => {
    const closed = mark({ cardBlock: { at: DUE.toISOString(), priorStatus: "ACTIVE" } });
    expect(cardVerdict(closed, facts({ status: "ACTIVE" }), new Date(DUE.getTime() + 30 * DAY))).toEqual({ act: "leave" });
  });

  it("a closed organization opens with a card, and only with one, and only while it is still closed", () => {
    const closed = mark({ cardBlock: { at: DUE.toISOString(), priorStatus: "ACTIVE" } });
    expect(cardVerdict(closed, facts({ status: "PENDING_PAYMENT", hasCard: true }), DUE)).toEqual({ act: "restore" });
    expect(cardVerdict(closed, facts({ status: "PENDING_PAYMENT", hasCard: false }), DUE)).toEqual({ act: "leave" });
    expect(cardVerdict(closed, facts({ status: "SUSPENDED", hasCard: true }), DUE)).toEqual({ act: "leave" });
  });
});

describe("the sweep", () => {
  it("closes exactly the organizations that are due with no card, and leaves every other one as it was", async () => {
    org("t_due", "ACTIVE");
    org("t_setting_up", "PENDING_ONBOARDING");
    org("t_no_billing", "PENDING_ADMIN_SETUP", mark(), { entity: false });
    org("t_early", "ACTIVE", mark({ at: new Date(DUE.getTime() - 14 * DAY + 1).toISOString() }));
    org("t_card", "ACTIVE", mark(), { cards: ["ACTIVE"] });
    org("t_removed_card", "ACTIVE", mark(), { cards: ["REMOVED"] });
    org("t_own_plan", "ACTIVE", mark(), { plan: "growth" });
    org("t_suspended", "SUSPENDED");
    org("t_damaged", "ACTIVE", { at: "not a date", cardRequiredAfterDays: 14 });
    org("t_days_zero", "ACTIVE", { at: SIGNED_UP, cardRequiredAfterDays: 0 });

    const r = await sweepCardRequired(DUE);

    // The two damaged marks are not marks, so they are not even counted.
    expect(r).toEqual({ examined: 8, blocked: 4, restored: 0, failed: 0 });
    expect(Object.fromEntries([...H.tenants].map(([k, v]) => [k, v.status]))).toEqual({
      t_due: "PENDING_PAYMENT",
      t_setting_up: "PENDING_PAYMENT",
      t_no_billing: "PENDING_PAYMENT",
      t_removed_card: "PENDING_PAYMENT",
      t_early: "ACTIVE",
      t_card: "ACTIVE",
      t_own_plan: "ACTIVE",
      t_suspended: "SUSPENDED",
      t_damaged: "ACTIVE",
      t_days_zero: "ACTIVE",
    });
  });

  it("the mark remembers when it closed and what to put back, and keeps the numbers it was signed with", async () => {
    org("t_setting_up", "PENDING_ONBOARDING", mark({ trialDays: 10, cardRequiredAfterDays: 7, trialCredits: 800 }));
    const now = new Date(Date.parse(SIGNED_UP) + 9 * DAY);
    await sweepCardRequired(now);
    expect(H.marks.get("t_setting_up")).toEqual({
      at: SIGNED_UP, trialDays: 10, cardRequiredAfterDays: 7, trialCredits: 800,
      cardBlock: { at: now.toISOString(), priorStatus: "PENDING_ONBOARDING" },
    });
  });

  it("writes one audit line per closed organization, and refreshes the mark's cache with the same value", async () => {
    org("t_due", "ACTIVE");
    org("t_card", "ACTIVE", mark(), { cards: ["ACTIVE"] });
    await sweepCardRequired(DUE);
    expect(H.audits).toEqual([{
      tenantId: "t_due", actorType: "system", actorId: null, action: "billing.card_required_blocked",
      targetType: "tenant", targetId: "t_due",
      metadata: { before: { status: "ACTIVE" }, after: { status: "PENDING_PAYMENT" }, signedUpAt: SIGNED_UP, cardRequiredAfterDays: 14 },
    }]);
    expect(H.cache).toHaveLength(1);
    expect(H.cache[0].slice(0, 2)).toEqual(["t_due", SELF_SIGNUP_ORIGIN_KEY]);
    expect(JSON.parse(H.cache[0][2])).toEqual(H.marks.get("t_due"));
  });

  it("reads every mark from the database by its key, and asks nothing more about an organization whose day has not come", async () => {
    org("t_early", "ACTIVE", mark({ at: new Date(DUE.getTime() - 14 * DAY + 1).toISOString() }));
    org("t_due", "ACTIVE");
    await sweepCardRequired(DUE);
    expect(H.sweepReads).toHaveLength(1);
    expect(H.sweepReads[0].where).toEqual({ key: SELF_SIGNUP_ORIGIN_KEY });
    expect(H.factReads).toEqual(["t_due"]);
  });

  it("an hour later it closes nothing again and writes nothing", async () => {
    org("t_due", "ACTIVE");
    await sweepCardRequired(DUE);
    const after = JSON.stringify(H.marks.get("t_due"));
    H.audits = []; H.cache = [];
    expect(await sweepCardRequired(new Date(DUE.getTime() + 3_600_000))).toEqual({ examined: 1, blocked: 0, restored: 0, failed: 0 });
    expect(JSON.stringify(H.marks.get("t_due"))).toBe(after);
    expect(H.audits).toEqual([]); expect(H.cache).toEqual([]);
  });

  it("an organization an operator opened by hand after it was closed stays open", async () => {
    org("t_due", "ACTIVE");
    await sweepCardRequired(DUE);
    H.tenants.get("t_due")!.status = "ACTIVE";
    expect((await sweepCardRequired(new Date(DUE.getTime() + 5 * DAY))).blocked).toBe(0);
    expect(statusOf("t_due")).toBe("ACTIVE");
  });

  it("a status that changed between the read and the write is left alone, with no mark and no audit line", async () => {
    org("t_due", "ACTIVE");
    H.beforeTx = () => { H.tenants.get("t_due")!.status = "SUSPENDED"; };
    expect(await sweepCardRequired(DUE)).toEqual({ examined: 1, blocked: 0, restored: 0, failed: 0 });
    expect(statusOf("t_due")).toBe("SUSPENDED");
    expect(H.marks.get("t_due")).toEqual(mark());
    expect(H.audits).toEqual([]); expect(H.cache).toEqual([]);
  });

  it("a mark that could not be written leaves the status unchanged too, and the next organization is still swept", async () => {
    org("t_a_bad", "ACTIVE");
    org("t_b_good", "ACTIVE");
    H.markWriteThrowsFor = "t_a_bad";
    expect(await sweepCardRequired(DUE)).toEqual({ examined: 2, blocked: 1, restored: 0, failed: 1 });
    expect(statusOf("t_a_bad")).toBe("ACTIVE");
    expect(H.marks.get("t_a_bad")).toEqual(mark());
    expect(statusOf("t_b_good")).toBe("PENDING_PAYMENT");
    expect(H.audits.map((a) => a.tenantId)).toEqual(["t_b_good"]);
  });

  it("a cache that is away does not undo or hide the close", async () => {
    org("t_due", "ACTIVE");
    H.cacheThrows = true;
    expect((await sweepCardRequired(DUE)).blocked).toBe(1);
    expect(statusOf("t_due")).toBe("PENDING_PAYMENT");
    expect(markOf("t_due")?.cardBlock?.priorStatus).toBe("ACTIVE");
    expect(H.audits).toHaveLength(1);
  });

  it("with no marks at all there is nothing to do", async () => {
    H.tenants.set("t_old", { status: "ACTIVE" });
    expect(await sweepCardRequired(DUE)).toEqual({ examined: 0, blocked: 0, restored: 0, failed: 0 });
    expect(statusOf("t_old")).toBe("ACTIVE");
  });
});

describe("a stored card opens what the sweep closed", () => {
  const closed = (priorStatus: any) => mark({ cardBlock: { at: DUE.toISOString(), priorStatus } });
  const LATER = new Date(DUE.getTime() + 2 * DAY);

  it.each([
    ["ACTIVE", null, "ACTIVE"],
    ["PENDING_ONBOARDING", null, "PENDING_ONBOARDING"],
    ["PENDING_ADMIN_SETUP", null, "PENDING_ADMIN_SETUP"],
    // Setup was finished while the organization was closed.
    ["PENDING_ONBOARDING", new Date("2026-11-16T10:00:00.000Z"), "ACTIVE"],
    ["PENDING_ADMIN_SETUP", new Date("2026-11-16T10:00:00.000Z"), "ACTIVE"],
  ])("closed from %s, setup finished %s: back to %s", async (prior, completedAt, expected) => {
    org("t", "PENDING_PAYMENT", closed(prior), { cards: ["ACTIVE"] });
    H.onboarding.set("t", { completedAt: completedAt as Date | null });
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: true, status: expected });
    expect(statusOf("t")).toBe(expected);
  });

  it("an organization with no setup row at all goes back to the status the mark remembers", async () => {
    org("t", "PENDING_PAYMENT", closed("PENDING_ONBOARDING"), { cards: ["ACTIVE"] });
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: true, status: "PENDING_ONBOARDING" });
  });

  it("the mark drops the close, records the restore, keeps its numbers; one audit line; the cache gets the same value", async () => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: ["ACTIVE"] });
    await restoreAfterCard("t", LATER);
    expect(H.marks.get("t")).toEqual({
      at: SIGNED_UP, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000, cardRestoredAt: LATER.toISOString(),
    });
    expect(H.audits).toEqual([{
      tenantId: "t", actorType: "system", actorId: null, action: "billing.card_required_restored",
      targetType: "tenant", targetId: "t",
      metadata: { before: { status: "PENDING_PAYMENT" }, after: { status: "ACTIVE" }, closedAt: DUE.toISOString() },
    }]);
    expect(JSON.parse(H.cache[0][2])).toEqual(H.marks.get("t"));
  });

  it("a card does not open an organization that is closed for another reason: no mark, or a mark that was never closed", async () => {
    org("t_paid_plan", "PENDING_PAYMENT", undefined, { cards: ["ACTIVE"], plan: "growth" });
    org("t_never_closed", "PENDING_PAYMENT", mark(), { cards: ["ACTIVE"] });
    expect(await restoreAfterCard("t_paid_plan", LATER)).toEqual({ restored: false, reason: "not_closed_for_card" });
    expect(await restoreAfterCard("t_never_closed", LATER)).toEqual({ restored: false, reason: "not_closed_for_card" });
    expect(statusOf("t_paid_plan")).toBe("PENDING_PAYMENT");
    expect(statusOf("t_never_closed")).toBe("PENDING_PAYMENT");
    expect(H.audits).toEqual([]);
  });

  it.each([["SUSPENDED"], ["ACTIVE"]])("an organization whose status is %s by now is not touched", async (status) => {
    org("t", status, closed("ACTIVE"), { cards: ["ACTIVE"] });
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: false, reason: "not_closed_for_card" });
    expect(statusOf("t")).toBe(status);
    expect(markOf("t")?.cardBlock).toBeDefined();
  });

  it.each([[undefined], [["REMOVED"]]])("without an active card (cards: %j) it stays closed", async (cards) => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: cards as string[] | undefined });
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: false, reason: "no_card" });
    expect(statusOf("t")).toBe("PENDING_PAYMENT");
  });

  it.each([["PENDING"], ["AWAITING_PROVIDER"], ["TOKENIZED"]])("a first payment still owed (%s) keeps it closed", async (status) => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: ["ACTIVE"] });
    H.checkouts.push({ tenantId: "t", status });
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: false, reason: "checkout_open" });
    expect(statusOf("t")).toBe("PENDING_PAYMENT");
    expect(markOf("t")?.cardBlock).toBeDefined();
    // The sweep reaches the same refusal, and counts only what it opened.
    expect(await sweepCardRequired(LATER)).toEqual({ examined: 1, blocked: 0, restored: 0, failed: 0 });
    expect(statusOf("t")).toBe("PENDING_PAYMENT");
  });

  it.each([["PAID"], ["CANCELLED"], ["EXPIRED"]])("a checkout that is %s is not owed, and another organization's open one is not ours", async (status) => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: ["ACTIVE"] });
    H.checkouts.push({ tenantId: "t", status }, { tenantId: "t_other", status: "PENDING" });
    expect((await restoreAfterCard("t", LATER)).restored).toBe(true);
  });

  it("a status that changed between the read and the write is left as it is, and the mark stays closed", async () => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: ["ACTIVE"] });
    H.beforeTx = () => { H.tenants.get("t")!.status = "SUSPENDED"; };
    expect(await restoreAfterCard("t", LATER)).toEqual({ restored: false, reason: "status_changed" });
    expect(statusOf("t")).toBe("SUSPENDED");
    expect(markOf("t")?.cardBlock).toBeDefined();
    expect(H.audits).toEqual([]);
  });

  it("a mark that could not be written leaves it closed (the next sweep tries again)", async () => {
    org("t", "PENDING_PAYMENT", closed("ACTIVE"), { cards: ["ACTIVE"] });
    H.markWriteThrowsFor = "t";
    await expect(restoreAfterCard("t", LATER)).rejects.toThrow("could not be written");
    expect(statusOf("t")).toBe("PENDING_PAYMENT");
    H.markWriteThrowsFor = null;
    expect(await sweepCardRequired(LATER)).toEqual({ examined: 1, blocked: 0, restored: 1, failed: 0 });
    expect(statusOf("t")).toBe("ACTIVE");
  });
});

describe("the whole road, on one clock", () => {
  it("signed up, closed on its day, opened by a card, closed again when the card is removed", async () => {
    org("t", "PENDING_ONBOARDING");
    expect((await sweepCardRequired(new Date(DUE.getTime() - 3_600_000))).blocked).toBe(0);
    expect(await closedForCard("t")).toBe(false);

    expect((await sweepCardRequired(DUE)).blocked).toBe(1);
    expect(await closedForCard("t")).toBe(true);

    // The sweep alone does not open it: there is still no card.
    expect(await sweepCardRequired(new Date(DUE.getTime() + 3_600_000))).toEqual({ examined: 1, blocked: 0, restored: 0, failed: 0 });

    H.cards.set("ent_t", ["ACTIVE"]);
    H.onboarding.set("t", { completedAt: new Date(DUE.getTime() + 1000) });
    expect(await restoreAfterCard("t", new Date(DUE.getTime() + 2 * 3_600_000))).toEqual({ restored: true, status: "ACTIVE" });
    expect(await closedForCard("t")).toBe(false);
    expect((await sweepCardRequired(new Date(DUE.getTime() + 3 * 3_600_000))).blocked).toBe(0);

    H.cards.set("ent_t", ["REMOVED"]);
    const again = new Date(DUE.getTime() + 4 * 3_600_000);
    expect((await sweepCardRequired(again)).blocked).toBe(1);
    expect(statusOf("t")).toBe("PENDING_PAYMENT");
    expect(markOf("t")).toMatchObject({ cardBlock: { at: again.toISOString(), priorStatus: "ACTIVE" } });
  });

  it("closedForCard is false for a closed mark on an organization that is no longer PENDING_PAYMENT, for one with no mark, and for a mark that was never closed", async () => {
    org("t_opened", "ACTIVE", mark({ cardBlock: { at: DUE.toISOString(), priorStatus: "ACTIVE" } }));
    org("t_plain", "PENDING_PAYMENT", undefined);
    // Signed itself up, then bought a plan and owes its first payment: closed,
    // but not for a card.
    org("t_first_payment", "PENDING_PAYMENT", mark());
    expect(await closedForCard("t_opened")).toBe(false);
    expect(await closedForCard("t_plain")).toBe(false);
    expect(await closedForCard("t_first_payment")).toBe(false);
    expect(await closedForCard("t_gone")).toBe(false);
  });
});

describe("no provider, by construction", () => {
  const src = readFileSync(join(__dirname, "../services/card-required.service.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("imports only the shared package and the evaluation's plan key", () => {
    const from = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(from).toEqual(["@chatcenter/shared", "./poc.service"]);
    expect(code).not.toMatch(/require\(|import\(/);
  });

  it("names no provider, no charge and no network call", () => {
    // Two checkout statuses the restore reads are names, not calls.
    expect(code.replace(/"AWAITING_PROVIDER"|"TOKENIZED"/g, "")).not.toMatch(/icount|provider|charge|tokeniz|fetch\(|axios|http/i);
  });
});
