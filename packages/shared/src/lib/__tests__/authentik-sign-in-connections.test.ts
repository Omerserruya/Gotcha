/**
 * The Authentik reads behind "Sign in with Google" (2026-11-22).
 *
 * Three small functions, each with one way to be quietly wrong:
 *  - the connection list, where a failed read must not look like "none"
 *    (the caller reads "none" as "nothing connected") and a row that is not
 *    this person's must never come back (the caller deletes by these ids);
 *  - the delete, which must only ever reach the connection route;
 *  - the usable-password read, where "could not be told" must stay apart from
 *    "yes" (the caller removes a way to sign in on a "yes").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listUserSourceConnections, deleteOAuthSourceConnection, hasUsablePassword } from "../authentik";

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

const row = (pk: number, user: number, slug = "google", extra: Record<string, unknown> = {}) => ({
  pk, user, source: "aaaa", source_obj: { slug, name: slug === "google" ? "Google" : slug, pk: "aaaa" },
  identifier: `acct-${pk}`, created: "2026-11-20T09:15:00.000000Z", last_updated: "2026-11-21T10:00:00.000000Z", ...extra,
});

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = "pol-1";
  calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("listUserSourceConnections", () => {
  it("asks for one person's connections and returns them in our shape", async () => {
    stubFetch(() => ({ status: 200, body: { pagination: { current: 1, total_pages: 1 }, results: [row(31, 7)] } }));
    const out = await listUserSourceConnections(7);
    expect(out).toEqual([{ id: "31", sourceSlug: "google", sourceName: "Google", sourcePk: "aaaa", createdAt: "2026-11-20T09:15:00.000000Z" }]);
    expect(calls[0].url).toBe("http://authentik-server:9000/api/v3/sources/user_connections/all/?user=7&page=1&page_size=100");
  });

  it("the outside account's id never leaves the client", async () => {
    stubFetch(() => ({ status: 200, body: { pagination: { current: 1, total_pages: 1 }, results: [row(31, 7)] } }));
    const out = await listUserSourceConnections(7);
    expect(JSON.stringify(out)).not.toContain("acct-31");
  });

  it("drops every row that is not this person's", async () => {
    stubFetch(() => ({
      status: 200,
      body: { pagination: { current: 1, total_pages: 1 }, results: [row(40, 9), row(31, 7), row(41, 9, "microsoft")] },
    }));
    const out = await listUserSourceConnections(7);
    expect(out.map((c) => c.id)).toEqual(["31"]);
  });

  it("a row whose owner is not a plain match is dropped, not guessed", async () => {
    stubFetch(() => ({
      status: 200,
      body: { pagination: { current: 1, total_pages: 1 }, results: [row(31, "7" as any), { ...row(32, 7), user: undefined }, { ...row(33, 7), pk: null }] },
    }));
    expect(await listUserSourceConnections(7)).toEqual([]);
  });

  it("reads every page", async () => {
    stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return page === 1
        ? { status: 200, body: { pagination: { current: 1, total_pages: 2 }, results: [row(31, 7)] } }
        : { status: 200, body: { pagination: { current: 2, total_pages: 2 }, results: [row(32, 7, "microsoft")] } };
    });
    const out = await listUserSourceConnections(7);
    expect(out.map((c) => `${c.id}:${c.sourceSlug}`)).toEqual(["31:google", "32:microsoft"]);
  });

  it("a connection with no date says null, not an invented one", async () => {
    stubFetch(() => ({ status: 200, body: { pagination: { current: 1, total_pages: 1 }, results: [row(31, 7, "google", { created: null })] } }));
    expect((await listUserSourceConnections(7))[0].createdAt).toBeNull();
  });

  it("no connections is an empty list", async () => {
    stubFetch(() => ({ status: 200, body: { pagination: { current: 1, total_pages: 1 }, results: [] } }));
    expect(await listUserSourceConnections(7)).toEqual([]);
  });

  for (const status of [401, 403, 500, 503]) {
    it(`a ${status} throws: it is not "no connections"`, async () => {
      stubFetch(() => ({ status, body: { detail: "nope" } }));
      await expect(listUserSourceConnections(7)).rejects.toThrow(/authentik/);
    });
  }
});

describe("deleteOAuthSourceConnection", () => {
  it("deletes the one connection by its pk", async () => {
    stubFetch(() => ({ status: 204, body: null }));
    await deleteOAuthSourceConnection("31");
    expect(calls).toEqual([{ url: "http://authentik-server:9000/api/v3/sources/user_connections/oauth/31/", method: "DELETE", body: null }]);
  });

  for (const bad of ["", "abc", "31/", "31/../../../core/users/7", "../31", "31?x=1", " 31", "3 1", "-1"]) {
    it(`refuses the id ${JSON.stringify(bad)} without calling Authentik`, async () => {
      stubFetch(() => ({ status: 204, body: null }));
      await expect(deleteOAuthSourceConnection(bad)).rejects.toThrow(/connection id/);
      expect(calls).toEqual([]);
    });
  }

  it("a failed delete throws", async () => {
    stubFetch(() => ({ status: 500, body: { detail: "boom" } }));
    await expect(deleteOAuthSourceConnection("31")).rejects.toThrow(/authentik/);
  });
});

describe("hasUsablePassword", () => {
  it("asks the configured policy about this one person", async () => {
    stubFetch(() => ({ status: 200, body: { passing: true, messages: [], log_messages: [] } }));
    expect(await hasUsablePassword(7)).toBe(true);
    expect(calls).toEqual([{ url: "http://authentik-server:9000/api/v3/policies/all/pol-1/test/", method: "POST", body: { user: 7 } }]);
  });

  it("no password is false", async () => {
    stubFetch(() => ({ status: 200, body: { passing: false, messages: [], log_messages: [] } }));
    expect(await hasUsablePassword(7)).toBe(false);
  });

  for (const unset of [undefined, "", "   "]) {
    it(`policy pk ${JSON.stringify(unset)}: cannot be told, and Authentik is not asked`, async () => {
      if (unset === undefined) delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK;
      else process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = unset;
      stubFetch(() => ({ status: 200, body: { passing: true } }));
      expect(await hasUsablePassword(7)).toBeNull();
      expect(calls).toEqual([]);
    });
  }

  for (const status of [400, 403, 404, 500]) {
    it(`a ${status} from the policy test is "cannot be told", never yes`, async () => {
      stubFetch(() => ({ status, body: { detail: "nope" } }));
      expect(await hasUsablePassword(7)).toBeNull();
    });
  }

  for (const passing of ["true", 1, null, undefined, {}]) {
    it(`an answer of ${JSON.stringify(passing)} is "cannot be told"`, async () => {
      stubFetch(() => ({ status: 200, body: { passing } }));
      expect(await hasUsablePassword(7)).toBeNull();
    });
  }

  it("an empty answer is \"cannot be told\"", async () => {
    stubFetch(() => ({ status: 200, body: null }));
    expect(await hasUsablePassword(7)).toBeNull();
  });

  it("a policy pk cannot reach another route", async () => {
    process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = "../../core/users/7";
    stubFetch(() => ({ status: 200, body: { passing: true } }));
    await hasUsablePassword(7);
    expect(calls[0].url).toBe("http://authentik-server:9000/api/v3/policies/all/..%2F..%2Fcore%2Fusers%2F7/test/");
  });
});
