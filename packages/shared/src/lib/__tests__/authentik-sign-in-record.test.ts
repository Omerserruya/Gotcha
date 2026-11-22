/**
 * The Authentik reads behind "how did this person just sign in" (2026-11-22).
 *
 * Each function has one way to be quietly wrong:
 *  - the newest sign-in, where Authentik's own filters are loose (its `action`
 *    filter is "contains", so `login` brings `login_failed`; its `username`
 *    filter also matches a name typed on somebody's failed form), so a failed
 *    attempt or another person's event must never be read as this person's
 *    sign-in;
 *  - the id comparison, where one UUID is written two ways (dashes from the
 *    API, bare hex inside an event) and an empty id must match nothing;
 *  - the recovery token removal, which must only ever reach that one token,
 *    and where "there was none" must stay apart from "could not ask".
 *
 * Field names are read from Authentik 2026.2's own source: events/utils.py
 * (get_user, model_to_dict, sanitize_item), events/signals.py
 * (on_user_logged_in), core/api/users.py (_create_recovery_link).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readLatestSignIn, sameAuthentikId, deleteRecoveryToken, findIdentityBySubject } from "../authentik";

const realFetch = global.fetch;
let calls: { url: string; method: string; body: any }[] = [];

function stubFetch(handler: (url: string, method: string, body: any) => { status: number; body: unknown }) {
  global.fetch = vi.fn(async (input: any, init: any = {}) => {
    const method = String(init.method || "GET");
    const sent = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), method, body: sent });
    const { status, body } = handler(String(input), method, sent);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === null ? "" : JSON.stringify(body)),
      json: async () => body,
    } as any;
  }) as any;
}

const UID = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SOURCE_HEX = "3fa85f6457174562b3fc2c963f66afa6";
const SOURCE_DASHED = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const event = (pk: string, action: string, userPk: number, created: string, context: Record<string, unknown> = {}) => ({
  pk, action, app: "authentik.events.signals", created, client_ip: "203.0.113.9",
  user: { pk: userPk, username: "dana@acme.com", email: "dana@acme.com" },
  context,
});
const events = (rows: unknown[]) => () => ({ status: 200, body: { pagination: { current: 1, total_pages: 1 }, results: rows } });

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  calls = [];
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("readLatestSignIn", () => {
  it("asks for one person's newest login events", async () => {
    stubFetch(events([]));
    await readLatestSignIn(7, "dana@acme.com");
    expect(calls).toEqual([{
      url: "http://authentik-server:9000/api/v3/events/events/?action=login&username=dana%40acme.com&ordering=-created&page_size=20",
      method: "GET", body: null,
    }]);
  });

  it("a sign-in on Authentik's own form: no source, and the password stage named", async () => {
    stubFetch(events([event("e1", "login", 7, "2026-11-22T08:00:00.000000Z", { auth_method: "password", auth_method_args: {} })]));
    expect(await readLatestSignIn(7, "dana@acme.com")).toEqual({
      eventId: "e1", at: "2026-11-22T08:00:00.000000Z", sourcePk: null, byPassword: true,
    });
  });

  it("a sign-in through an outside source carries that source's pk", async () => {
    stubFetch(events([event("e2", "login", 7, "2026-11-22T08:00:00.000000Z", {
      source: { app: "authentik_sources_oauth", model_name: "oauthsource", pk: SOURCE_HEX, name: "Google" },
    })]));
    expect(await readLatestSignIn(7, "dana@acme.com")).toEqual({
      eventId: "e2", at: "2026-11-22T08:00:00.000000Z", sourcePk: SOURCE_HEX, byPassword: false,
    });
  });

  it("a source sign-in followed by a two-step challenge is still a source sign-in, not a password one", async () => {
    stubFetch(events([event("e3", "login", 7, "2026-11-22T08:00:00.000000Z", {
      source: { app: "authentik_sources_oauth", model_name: "oauthsource", pk: SOURCE_HEX, name: "Google" },
      auth_method: "auth_mfa", auth_method_args: { mfa_devices: [] },
    })]));
    const out = await readLatestSignIn(7, "dana@acme.com");
    expect(out?.sourcePk).toBe(SOURCE_HEX);
    expect(out?.byPassword).toBe(false);
  });

  it.each([
    ["auth_mfa"], ["auth_webauthn_pwl"], ["token"], [""], [undefined], [true],
  ])("auth_method %j is not a password sign-in", async (auth_method) => {
    stubFetch(events([event("e4", "login", 7, "2026-11-22T08:00:00.000000Z", { auth_method })]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.byPassword).toBe(false);
  });

  it("a failed attempt that is newer than the sign-in is skipped, not read as the sign-in", async () => {
    stubFetch(events([
      event("f1", "login_failed", 7, "2026-11-22T09:00:00.000000Z", { username: "dana@acme.com" }),
      event("e5", "login", 7, "2026-11-22T08:00:00.000000Z", { auth_method: "password" }),
    ]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.eventId).toBe("e5");
  });

  it("another person's sign-in that the username filter let through is never this person's", async () => {
    stubFetch(events([
      event("x1", "login", 9, "2026-11-22T09:00:00.000000Z", { auth_method: "password", username: "dana@acme.com" }),
      event("e6", "login", 7, "2026-11-22T08:00:00.000000Z", { source: { pk: SOURCE_HEX } }),
    ]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.eventId).toBe("e6");
  });

  it("the newest of several sign-ins is the one returned", async () => {
    stubFetch(events([
      event("new", "login", 7, "2026-11-22T09:00:00.000000Z", { source: { pk: SOURCE_HEX } }),
      event("old", "login", 7, "2026-11-20T09:00:00.000000Z", { auth_method: "password" }),
    ]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.eventId).toBe("new");
  });

  it.each([
    ["no events at all", []],
    ["only failed attempts", [event("f1", "login_failed", 7, "2026-11-22T09:00:00.000000Z")]],
    ["only somebody else's", [event("x1", "login", 9, "2026-11-22T09:00:00.000000Z")]],
    ["an event with no user", [{ pk: "n1", action: "login", created: "2026-11-22T09:00:00.000000Z", context: {} }]],
    ["an event with no id", [{ ...event("", "login", 7, "2026-11-22T09:00:00.000000Z"), pk: null }]],
  ])("null when there is %s", async (_name, rows) => {
    stubFetch(events(rows));
    expect(await readLatestSignIn(7, "dana@acme.com")).toBeNull();
  });

  it("null (not a throw) when the answer has no results key", async () => {
    stubFetch(() => ({ status: 200, body: {} }));
    expect(await readLatestSignIn(7, "dana@acme.com")).toBeNull();
  });

  it.each([
    ["an empty source object", { source: {} }],
    ["a source with an empty pk", { source: { pk: "" } }],
    ["a source that is a string", { source: "google" }],
    ["a null source", { source: null }],
  ])("%s is not a source sign-in", async (_name, context) => {
    stubFetch(events([event("e7", "login", 7, "2026-11-22T08:00:00.000000Z", context)]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.sourcePk).toBeNull();
  });

  it("a missing date is null, not a made-up one", async () => {
    stubFetch(events([{ ...event("e8", "login", 7, ""), created: undefined }]));
    expect((await readLatestSignIn(7, "dana@acme.com"))?.at).toBeNull();
  });

  it.each([[401], [403], [500], [503]])("throws on %i, so a failed read is never 'no sign-in'", async (status) => {
    stubFetch(() => ({ status, body: { detail: "no" } }));
    await expect(readLatestSignIn(7, "dana@acme.com")).rejects.toThrow(/authentik/);
  });
});

describe("sameAuthentikId", () => {
  it.each([
    [SOURCE_DASHED, SOURCE_HEX],
    [SOURCE_HEX, SOURCE_DASHED],
    [SOURCE_HEX.toUpperCase(), SOURCE_DASHED],
    [` ${SOURCE_HEX} `, SOURCE_HEX],
    ["aaaa", "aaaa"],
    [42, "42"],
  ])("%j and %j are the same id", (a, b) => {
    expect(sameAuthentikId(a, b)).toBe(true);
  });

  it.each([
    [SOURCE_HEX, SOURCE_HEX.replace(/6$/, "7")],
    ["aaaa", "bbbb"],
    ["aaaa", "aaa"],
    ["", ""],
    [null, null],
    [undefined, undefined],
    [null, ""],
    ["-", "--"],
    ["aaaa", null],
    [undefined, "aaaa"],
  ])("%j and %j are not", (a, b) => {
    expect(sameAuthentikId(a, b)).toBe(false);
  });
});

describe("deleteRecoveryToken", () => {
  it("removes the person's one password-reset token, by Authentik's own name for it", async () => {
    stubFetch(() => ({ status: 204, body: null }));
    expect(await deleteRecoveryToken(UID)).toBe(true);
    expect(calls).toEqual([{ url: `http://authentik-server:9000/api/v3/core/tokens/${UID}-password-reset/`, method: "DELETE", body: null }]);
  });

  it("no token is false, not an error", async () => {
    stubFetch(() => ({ status: 404, body: { detail: "Not found." } }));
    expect(await deleteRecoveryToken(UID)).toBe(false);
  });

  it.each([[401], [403], [500], [503]])("throws on %i: 'could not ask' is not 'there was none'", async (status) => {
    stubFetch(() => ({ status, body: { detail: "no" } }));
    await expect(deleteRecoveryToken(UID)).rejects.toThrow(/authentik/);
  });

  it.each([
    [""], ["../users/7"], ["abc/../../sources"], ["7"], [`${UID}-password-reset`], [`${UID}/`], ["akadmin"], [`${UID.toUpperCase()}`], [undefined as any], [null as any],
  ])("refuses %j before any request, so it can only ever reach that token", async (uid) => {
    stubFetch(() => ({ status: 204, body: null }));
    await expect(deleteRecoveryToken(uid)).rejects.toThrow(/uid/);
    expect(calls).toEqual([]);
  });
});

describe("findIdentityBySubject", () => {
  it("carries Authentik's uid when the row has one, and leaves it out when it does not", async () => {
    stubFetch(() => ({ status: 200, body: { results: [{ uuid: "sub-dana", pk: 7, email: "dana@acme.com", username: "dana@acme.com", uid: UID }] } }));
    expect(await findIdentityBySubject("sub-dana")).toEqual({ subject: "sub-dana", pk: 7, email: "dana@acme.com", username: "dana@acme.com", uid: UID });
    stubFetch(() => ({ status: 200, body: { results: [{ uuid: "sub-dana", pk: 7, email: "dana@acme.com", username: "dana@acme.com" }] } }));
    expect(await findIdentityBySubject("sub-dana")).toEqual({ subject: "sub-dana", pk: 7, email: "dana@acme.com", username: "dana@acme.com" });
  });
});
