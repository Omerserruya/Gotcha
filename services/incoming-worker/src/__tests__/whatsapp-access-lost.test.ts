/**
 * ★ A WhatsApp number our app can no longer reach stops saying CONNECTED
 * (2026-11-22).
 *
 * The case: a business connected its number, then removed GOTCHA at Meta 14
 * minutes later. Meta said so (PARTNER_APP_UNINSTALLED + PARTNER_REMOVED) and
 * nothing read it. The token stayed valid, so the 6-hourly check wrote
 * CONNECTED every time, while the number read beside it was refused every
 * time ("Object with ID ... does not exist, cannot be loaded due to missing
 * permissions", Meta 100/33). Five days, zero messages, "connected".
 *
 * Two ways into the error state, one way out:
 *  - Meta's event, forwarded by the webhook as a channel-health job;
 *  - two refused number reads in a row;
 *  - a number read that succeeds clears it.
 * Nobody is notified (Omer, 2026-11-22: the state only, for now), so this
 * file also pins that nothing reaches the notifications queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => {
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "secret";
  return {
    accounts: [] as any[],
    numbers: [] as Array<{ wabaId: string; channelAccountId: string }>,
    numbersFail: false,
    read: {} as Record<string, "ok" | "ok_empty" | "refused" | "timeout" | "rate_limit">,
    tokenValid: true,
    writes: [] as any[],
    manyWheres: [] as any[],
    emitted: [] as any[],
    queries: 0,
  };
});

const REFUSED = { message: "Unsupported get request. Object with ID '1010938148762991' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", type: "GraphMethodException", code: 100, error_subcode: 33 };

vi.mock("axios", () => ({
  default: {
    get: async (url: string) => {
      if (url.endsWith("/debug_token")) return { data: { data: H.tokenValid ? { is_valid: true, expires_at: 0 } : { is_valid: false, error: { message: "Session has expired" } } } };
      const id = url.split("/").pop() as string;
      const mode = H.read[id] ?? "ok";
      if (mode === "refused") throw Object.assign(new Error("400"), { response: { status: 400, data: { error: REFUSED } } });
      if (mode === "timeout") throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
      if (mode === "rate_limit") throw Object.assign(new Error("400"), { response: { status: 400, data: { error: { message: "(#4) Application request limit reached", code: 4 } } } });
      if (mode === "ok_empty") return { data: { id } };
      return { data: { id, display_phone_number: "+972 52-540-1686", verified_name: "Alma Studio", quality_rating: "GREEN" } };
    },
    post: async () => ({ data: {} }),
  },
}));

/** The part of a Prisma `where` these writes use, with SQL's rule that NOT over a NULL column is not true. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (k === "NOT") {
      const [[col, cond]] = Object.entries(v) as [[string, any]];
      if (row[col] === null || row[col] === undefined) return false;
      return !matches(row, { [col]: cond });
    }
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    if (v && typeof v === "object" && "startsWith" in v) return typeof row[k] === "string" && row[k].startsWith(v.startsWith);
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    decryptCredentials: (s: string) => {
      if (!s.startsWith("enc:")) throw new Error("cannot decrypt");
      return JSON.parse(s.slice(4));
    },
    prisma: {
      channelAccount: {
        findMany: async (a: any) => { H.queries++; return H.accounts.filter((r) => matches(r, a?.where ?? {})).map((r) => ({ ...r })); },
        update: async (a: any) => {
          H.writes.push(a);
          Object.assign(H.accounts.find((r) => r.id === a.where.id), a.data);
          return {};
        },
        updateMany: async (a: any) => {
          H.manyWheres.push(a.where);
          const hit = H.accounts.filter((r) => matches(r, a.where));
          for (const r of hit) Object.assign(r, a.data);
          if (hit.length) H.writes.push(a);
          return { count: hit.length };
        },
      },
      whatsAppNumber: {
        findMany: async (a: any) => {
          H.queries++;
          if (H.numbersFail) throw new Error("relation \"whatsapp_numbers\" does not exist");
          return H.numbers.filter((n) => n.wabaId === a.where.wabaId).map((n) => ({ channelAccountId: n.channelAccountId }));
        },
      },
    },
  };
});
// Nothing here may put a job on a queue: any Queue.add in the run is recorded.
vi.mock("bullmq", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, Queue: class { add(...a: any[]) { H.emitted.push(a); return Promise.resolve(); } on() { return this; } } };
});

import { runHealthCheck, processChannelHealth } from "../workers/channel-health.worker";
import {
  afterNumberRead, onWhatsAppAccessRemoved, hasAccessLostCode, refusedReads,
  ACCESS_LOST_CODES, REFUSED_READS_BEFORE_ERROR, REFUSED_READS_KEY,
} from "../services/whatsapp-access";

const REMOVED = "[WHATSAPP_ACCESS_REMOVED] GOTCHA's access to this WhatsApp Business account was removed at Meta. Connect the number again.";
const UNREADABLE = "[WHATSAPP_NUMBER_UNREADABLE] Meta refused two checks of this number in a row: it does not exist there or GOTCHA may not read it. Connect the number again.";
const WABA = "200000000000002";

const wa = (o: any = {}) => ({
  id: "ca_alma", tenantId: "T_alma", channel: "WHATSAPP", externalId: "1010938148762991", isActive: true,
  connectionStatus: "CONNECTED", lastError: null, credentials: { accessToken: "tok", wabaId: WABA },
  platformMeta: { wabaId: WABA, displayPhoneNumber: "+972 52-540-1686", historyImport: "done" }, ...o,
});
const row = (id = "ca_alma") => H.accounts.find((r) => r.id === id);

beforeEach(() => {
  H.accounts = []; H.numbers = []; H.numbersFail = false; H.read = {}; H.tokenValid = true;
  H.writes = []; H.manyWheres = []; H.emitted = []; H.queries = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
// The state only: no test in this file may end with a job put on any queue.
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  expect(H.emitted).toEqual([]);
});

describe("the fixed words and numbers", () => {
  it("two codes, two refusals, one counter key", () => {
    expect([...ACCESS_LOST_CODES]).toEqual(["WHATSAPP_ACCESS_REMOVED", "WHATSAPP_NUMBER_UNREADABLE"]);
    expect(REFUSED_READS_BEFORE_ERROR).toBe(2);
    expect(REFUSED_READS_KEY).toBe("numberReadRefusals");
  });
  it("hasAccessLostCode knows its two codes and no other", () => {
    expect(hasAccessLostCode(REMOVED)).toBe(true);
    expect(hasAccessLostCode(UNREADABLE)).toBe(true);
    for (const other of [null, undefined, "", "Token is invalid or expired", "[SUBSCRIBE_FAILED] Connected, but new messages cannot arrive.", "WHATSAPP_ACCESS_REMOVED", "[WHATSAPP_ACCESS_REMOVED]"]) {
      expect(hasAccessLostCode(other as any), String(other)).toBe(false);
    }
  });
  it("refusedReads reads a stored count and nothing else as zero", () => {
    expect(refusedReads({ numberReadRefusals: 1 })).toBe(1);
    expect(refusedReads({ numberReadRefusals: 3 })).toBe(3);
    for (const meta of [null, undefined, {}, [], "x", { numberReadRefusals: "many" }, { numberReadRefusals: -1 }, { numberReadRefusals: 1.5 }, { numberReadRefusals: null }]) {
      expect(refusedReads(meta), JSON.stringify(meta)).toBe(0);
    }
  });
});

describe("afterNumberRead: what one read of the number does to the row", () => {
  const good = { ok: true as const, details: { displayPhoneNumber: "+972 52-540-1686" } };
  const refused = { ok: false as const, refused: true, message: REFUSED.message };
  const timeout = { ok: false as const, refused: false, message: "timeout of 10000ms exceeded" };

  it("a good read on a healthy row: CONNECTED, the details merged, nothing erased", () => {
    expect(afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA, historyImport: "done" } }, good)).toEqual({
      connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false,
      platformMeta: { wabaId: WABA, historyImport: "done", displayPhoneNumber: "+972 52-540-1686" },
    });
  });

  it("a good read with no details and no count leaves platformMeta alone", () => {
    const step = afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA } }, { ok: true, details: null });
    expect(step).toEqual({ connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false });
    expect(step).not.toHaveProperty("platformMeta");
  });

  it("★ the first refusal counts 1 and the row stays CONNECTED", () => {
    expect(afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA } }, refused)).toEqual({
      connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false, platformMeta: { wabaId: WABA, numberReadRefusals: 1 },
    });
  });

  it("★ the second refusal in a row is the error state, and it is the change", () => {
    expect(afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA, numberReadRefusals: 1 } }, refused)).toEqual({
      connectionStatus: "ERROR", lastError: UNREADABLE, becameUnreadable: true, platformMeta: { wabaId: WABA, numberReadRefusals: 2 },
    });
  });

  it("a third refusal keeps the state and is NOT a change", () => {
    expect(afterNumberRead({ lastError: UNREADABLE, platformMeta: { numberReadRefusals: 2 } }, refused)).toEqual({
      connectionStatus: "ERROR", lastError: UNREADABLE, becameUnreadable: false, platformMeta: { numberReadRefusals: 3 },
    });
  });

  it("a refusal on a row Meta's event already marked keeps that mark, whatever the count", () => {
    for (const platformMeta of [{}, { numberReadRefusals: 1 }, { numberReadRefusals: 7 }]) {
      const step = afterNumberRead({ lastError: REMOVED, platformMeta }, refused);
      expect(step).toMatchObject({ connectionStatus: "ERROR", lastError: REMOVED, becameUnreadable: false });
    }
  });

  it("★ a good read between two refusals starts the count again", () => {
    const first = afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA } }, refused);
    const back = afterNumberRead({ lastError: first.lastError, platformMeta: first.platformMeta }, good);
    expect(back.platformMeta).toEqual({ wabaId: WABA, displayPhoneNumber: "+972 52-540-1686" });
    const again = afterNumberRead({ lastError: back.lastError, platformMeta: back.platformMeta }, refused);
    expect(again).toMatchObject({ connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false, platformMeta: { numberReadRefusals: 1 } });
  });

  it("a good read with no details still drops a stored count", () => {
    expect(afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA, numberReadRefusals: 1 } }, { ok: true, details: null })).toEqual({
      connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false, platformMeta: { wabaId: WABA },
    });
  });

  it.each([[REMOVED], [UNREADABLE]])("★ a good read clears %s", (lastError) => {
    expect(afterNumberRead({ lastError, platformMeta: { wabaId: WABA, numberReadRefusals: 2 } }, good)).toEqual({
      connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false, platformMeta: { wabaId: WABA, displayPhoneNumber: "+972 52-540-1686" },
    });
  });

  it("a failure that is not a refusal counts nothing: a healthy row reads as before", () => {
    const step = afterNumberRead({ lastError: null, platformMeta: { wabaId: WABA, numberReadRefusals: 1 } }, timeout);
    expect(step).toEqual({ connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false });
    expect(step).not.toHaveProperty("platformMeta");
  });

  it.each([[REMOVED], [UNREADABLE]])("★ a failure that is not a refusal does NOT clear %s", (lastError) => {
    const step = afterNumberRead({ lastError, platformMeta: { numberReadRefusals: 2 } }, timeout);
    expect(step).toEqual({ connectionStatus: "ERROR", lastError, becameUnreadable: false });
  });

  it("a valid token with any other stored error still clears it, as before", () => {
    for (const read of [timeout, refused, good]) {
      expect(afterNumberRead({ lastError: "Token is invalid or expired", platformMeta: {} }, read)).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    }
  });
});

describe("★ the 6-hourly check, on a number GOTCHA was removed from", () => {
  it("refused, refused: CONNECTED with a count, then ERROR with the reason, and it stays", async () => {
    H.accounts = [wa()];
    H.read["1010938148762991"] = "refused";

    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "CONNECTED", lastError: null, platformMeta: { wabaId: WABA, historyImport: "done", numberReadRefusals: 1 } });

    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: UNREADABLE, platformMeta: { numberReadRefusals: 2, displayPhoneNumber: "+972 52-540-1686" } });

    await runHealthCheck();
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: UNREADABLE });
  });

  it("the state clears by itself on the next read that succeeds, and a later loss sets it again", async () => {
    H.accounts = [wa({ connectionStatus: "ERROR", lastError: UNREADABLE, platformMeta: { wabaId: WABA, numberReadRefusals: 4 } })];
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    expect(row().platformMeta).toEqual({ wabaId: WABA, displayPhoneNumber: "+972 52-540-1686", verifiedName: "Alma Studio", qualityRating: "GREEN" });

    H.read["1010938148762991"] = "refused";
    await runHealthCheck();
    await runHealthCheck();
    expect(row().connectionStatus).toBe("ERROR");
  });

  it.each([["timeout" as const], ["rate_limit" as const]])("a %s is no evidence: no count, no state, however often", async (mode) => {
    H.accounts = [wa()];
    H.read["1010938148762991"] = mode;
    for (let i = 0; i < 4; i++) await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    expect(row().platformMeta).toEqual({ wabaId: WABA, displayPhoneNumber: "+972 52-540-1686", historyImport: "done" });
  });

  it("★ a row Meta's event marked is NOT set back to CONNECTED by a valid token alone", async () => {
    H.accounts = [wa({ connectionStatus: "ERROR", lastError: REMOVED })];
    for (const mode of ["timeout", "refused", "rate_limit", "refused"] as const) {
      H.read["1010938148762991"] = mode;
      await runHealthCheck();
      expect(row(), mode).toMatchObject({ connectionStatus: "ERROR", lastError: REMOVED });
    }
    H.read["1010938148762991"] = "ok";
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("each number is judged by its own read: three lost in one run, the fourth untouched", async () => {
    H.accounts = [
      wa({ id: "ca_1", externalId: "111", platformMeta: { displayPhoneNumber: "+972 50-000-0001", numberReadRefusals: 1 } }),
      wa({ id: "ca_2", externalId: "222", platformMeta: { displayPhoneNumber: "+972 50-000-0002", numberReadRefusals: 1 } }),
      wa({ id: "ca_3", externalId: "333", tenantId: "T_other", platformMeta: { numberReadRefusals: 1 } }),
      wa({ id: "ca_4", externalId: "444", tenantId: "T_fine" }),
    ];
    H.read = { "111": "refused", "222": "refused", "333": "refused" };
    await runHealthCheck();
    for (const id of ["ca_1", "ca_2", "ca_3"]) expect(row(id), id).toMatchObject({ connectionStatus: "ERROR", lastError: UNREADABLE });
    expect(row("ca_4")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("an invalid token is what it always was: ERROR with Meta's reason, no number read", async () => {
    H.accounts = [wa()];
    H.tokenValid = false;
    H.read["1010938148762991"] = "refused";
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: "Session has expired" });
    expect(row().platformMeta).toEqual({ wabaId: WABA, displayPhoneNumber: "+972 52-540-1686", historyImport: "done" });
  });
});

describe("★ Meta's event: PARTNER_REMOVED / PARTNER_APP_UNINSTALLED for a WABA we hold", () => {
  const event = (e = "PARTNER_REMOVED", wabaId: any = WABA) => onWhatsAppAccessRemoved({ wabaId, event: e });

  it("the WABA's number goes to ERROR with the reason", async () => {
    H.accounts = [wa()];
    expect(await event()).toEqual({ held: 1, marked: 1 });
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: REMOVED });
  });

  it("★ the two events Meta sends together change the row once", async () => {
    H.accounts = [wa()];
    expect(await event("PARTNER_APP_UNINSTALLED")).toEqual({ held: 1, marked: 1 });
    expect(await event("PARTNER_REMOVED")).toEqual({ held: 1, marked: 0 });
    expect(H.writes).toHaveLength(1);
  });

  it("★ the write is conditional on the row not being in the state yet (and a NULL lastError counts as not)", async () => {
    H.accounts = [wa()];
    await event();
    expect(H.manyWheres).toEqual([{
      id: "ca_alma", channel: "WHATSAPP", isActive: true, connectionStatus: { in: ["CONNECTED", "ERROR"] },
      OR: [
        { lastError: null },
        { AND: [
          { NOT: { lastError: { startsWith: "[WHATSAPP_ACCESS_REMOVED] " } } },
          { NOT: { lastError: { startsWith: "[WHATSAPP_NUMBER_UNREADABLE] " } } },
        ] },
      ],
    }]);
  });

  it("a number the check already called unreadable keeps that reason", async () => {
    H.accounts = [wa({ connectionStatus: "ERROR", lastError: UNREADABLE })];
    expect(await event()).toEqual({ held: 1, marked: 0 });
    expect(row().lastError).toBe(UNREADABLE);
  });

  it("a row in ERROR for another reason is marked: this reason is the one that needs a reconnect", async () => {
    H.accounts = [
      wa({ id: "ca_1", connectionStatus: "ERROR", lastError: "Token is invalid or expired" }),
      wa({ id: "ca_2", connectionStatus: "ERROR", lastError: null }),
    ];
    expect(await event()).toEqual({ held: 2, marked: 2 });
    expect(row("ca_1").lastError).toBe(REMOVED);
    expect(row("ca_2").lastError).toBe(REMOVED);
  });

  it("the WABA is found by its whatsapp_numbers row, by platformMeta, or by the stored credentials", async () => {
    H.accounts = [
      wa({ id: "by_number", tenantId: "T1", platformMeta: null, credentials: { accessToken: "t" } }),
      wa({ id: "by_meta", tenantId: "T2", credentials: { accessToken: "t" } }),
      wa({ id: "by_creds", tenantId: "T3", platformMeta: {}, credentials: { accessToken: "t", wabaId: WABA } }),
      wa({ id: "by_sealed_creds", tenantId: "T4", platformMeta: null, credentials: `enc:${JSON.stringify({ accessToken: "t", wabaId: WABA })}` }),
      wa({ id: "other_waba", tenantId: "T5", platformMeta: { wabaId: "999" }, credentials: { accessToken: "t", wabaId: "999" } }),
      wa({ id: "unreadable_creds", tenantId: "T6", platformMeta: null, credentials: "garbage" }),
    ];
    H.numbers = [{ wabaId: WABA, channelAccountId: "by_number" }, { wabaId: "999", channelAccountId: "other_waba" }];
    expect(await event()).toEqual({ held: 4, marked: 4 });
    expect(H.accounts.filter((r) => r.connectionStatus === "ERROR").map((r) => r.id)).toEqual(["by_number", "by_meta", "by_creds", "by_sealed_creds"]);
    expect(row("other_waba")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("whatsapp_numbers unreadable: the row's own stored WABA id still finds it", async () => {
    H.accounts = [wa()];
    H.numbersFail = true;
    expect(await event()).toEqual({ held: 1, marked: 1 });
    expect(row().connectionStatus).toBe("ERROR");
  });

  it("a number the owner disconnected, or a switched-off row, is left alone", async () => {
    H.accounts = [wa({ id: "off", connectionStatus: "DISCONNECTED" }), wa({ id: "inactive", isActive: false }), wa({ id: "messenger", channel: "MESSENGER" })];
    expect(await event()).toEqual({ held: 0, marked: 0 });
    expect(H.writes).toEqual([]);
  });

  it("a WABA with no channel account of ours (GOTCHA's own alerts number) changes nothing", async () => {
    H.accounts = [wa({ platformMeta: { wabaId: "999" }, credentials: { accessToken: "t", wabaId: "999" } })];
    expect(await event("PARTNER_REMOVED", "555")).toEqual({ held: 0, marked: 0 });
    expect(H.writes).toEqual([]);
  });

  it.each([[""], ["   "], [undefined], [null], [123], [{ id: WABA }]])("a job with wabaId %j touches nothing and asks nothing", async (wabaId) => {
    H.accounts = [wa({ platformMeta: { wabaId: "" }, credentials: { accessToken: "t", wabaId: "" } })];
    expect(await onWhatsAppAccessRemoved({ wabaId, event: "PARTNER_REMOVED" })).toEqual({ held: 0, marked: 0 });
    expect(H.queries).toBe(0);
    expect(H.writes).toEqual([]);
  });

  it("the channel-health job carries it: type whatsapp_access_removed", async () => {
    H.accounts = [wa()];
    await processChannelHealth({ data: { type: "whatsapp_access_removed", wabaId: WABA, event: "PARTNER_REMOVED" } } as any);
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: REMOVED });
  });

  it("after the event, the 6-hourly check keeps the state until a read succeeds", async () => {
    H.accounts = [wa()];
    await event();
    H.read["1010938148762991"] = "refused";
    await runHealthCheck();
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "ERROR", lastError: REMOVED });
    H.read["1010938148762991"] = "ok";
    await runHealthCheck();
    expect(row()).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });
});
