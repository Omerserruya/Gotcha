/**
 * One address is one person, whatever its case (2026-11-22).
 *
 * Authentik matches an outside sign-in (Google) to a person by the EXACT email,
 * and Google hands addresses over in lowercase. Two things follow:
 *  - a new identity is stored in lowercase, or "Dana@Acme.com" could never
 *    sign in with Google;
 *  - an identity that already exists in another case is found and returned as
 *    it is, never forked into a second person. Authentik's `email` filter is
 *    exact, so finding it takes its `search`, which is "contains" over email,
 *    name and username and therefore also brings other people. Only a row
 *    whose email IS the address may ever be returned.
 *
 * Filter and paging names are read from Authentik 2026.2's own source
 * (core/api/users.py UsersFilter and search_fields, api/pagination.py).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureIdentity, findIdentityByEmail } from "../authentik";

const realFetch = global.fetch;
let calls: { method: string; path: string; body: any }[] = [];

interface AkUser { uuid: string; pk: number; email: string; username: string; name?: string }
const A = {
  users: [] as AkUser[],
  pageSize: 100,
  seq: 100,
  failSearch: false,
  failCreate: false,
  /** A server whose exact filter is loose and answers with everybody. */
  looseEmailFilter: false,
};

const ok = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => (body === null ? "" : JSON.stringify(body)), json: async () => body,
}) as any;

function authentik(input: any, init: any = {}) {
  const url = new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v3/, "");
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: path + url.search, body });

  if (method === "GET" && path === "/core/users/") {
    if (url.searchParams.has("email")) {
      const want = url.searchParams.get("email");
      return ok({ results: A.users.filter((u) => A.looseEmailFilter || u.email === want) });
    }
    if (url.searchParams.has("search")) {
      if (A.failSearch) return ok({ detail: "boom" }, 500);
      const q = String(url.searchParams.get("search")).toLowerCase();
      const all = A.users.filter((u) => [u.email, u.username, u.name].some((f) => String(f ?? "").toLowerCase().includes(q)));
      const size = Math.min(Number(url.searchParams.get("page_size")), A.pageSize);
      const page = Number(url.searchParams.get("page") || 1);
      const results = all.slice((page - 1) * size, page * size);
      return ok({ pagination: { next: page * size < all.length ? page + 1 : 0, current: page }, results });
    }
  }
  if (method === "POST" && path === "/core/users/") {
    if (A.failCreate) return ok({ username: ["This field must be unique."] }, 400);
    const u = { uuid: `sub-${++A.seq}`, pk: A.seq, email: body.email, username: body.username, name: body.name };
    A.users.push(u);
    return ok(u, 201);
  }
  return ok({ detail: "not found" }, 404);
}

const person = (pk: number, email: string, extra: Partial<AkUser> = {}): AkUser =>
  ({ uuid: `sub-${pk}`, pk, email, username: email, ...extra });
const posts = () => calls.filter((c) => c.method === "POST");
const gets = () => calls.filter((c) => c.method === "GET").map((c) => c.path);

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  calls = [];
  A.users = [];
  A.pageSize = 100;
  A.seq = 100;
  A.failSearch = false;
  A.failCreate = false;
  A.looseEmailFilter = false;
  global.fetch = vi.fn(async (input: any, init: any) => authentik(input, init)) as any;
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ensureIdentity: a new person is stored in lowercase", () => {
  it.each([
    ["Dana@Acme.com"], ["DANA@ACME.COM"], ["dana@acme.com"], ["  Dana@Acme.com  "],
  ])("%j is created as dana@acme.com, email and username both", async (typed) => {
    const out = await ensureIdentity(typed, "Dana");
    expect(posts()).toEqual([{
      method: "POST", path: "/core/users/",
      body: { username: "dana@acme.com", email: "dana@acme.com", name: "Dana", is_active: true, path: "users", type: "external" },
    }]);
    expect(out).toEqual({ subject: "sub-101", pk: 101, email: "dana@acme.com", username: "dana@acme.com" });
  });

  it("the name is sent as given: only the address is lowercased", async () => {
    await ensureIdentity("Dana@Acme.com", "Dana LEVI");
    expect(posts()[0].body.name).toBe("Dana LEVI");
  });

  it("every lookup comes before the create, and all three are asked", async () => {
    await ensureIdentity("Dana@Acme.com", "Dana");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /core/users/?email=Dana%40Acme.com",
      "GET /core/users/?email=dana%40acme.com",
      "GET /core/users/?search=dana%40acme.com&page_size=100&page=1",
      "POST /core/users/",
    ]);
  });

  it("a lowercase address is not asked for twice", async () => {
    await ensureIdentity("dana@acme.com", "Dana");
    expect(gets()).toEqual([
      "/core/users/?email=dana%40acme.com",
      "/core/users/?search=dana%40acme.com&page_size=100&page=1",
    ]);
  });
});

describe("ensureIdentity: a person who exists is returned as they are, never forked", () => {
  it("found as typed", async () => {
    A.users = [person(7, "dana@acme.com")];
    expect(await ensureIdentity("dana@acme.com", "Dana")).toEqual({ subject: "sub-7", pk: 7, email: "dana@acme.com", username: "dana@acme.com" });
    expect(posts()).toEqual([]);
  });

  it("stored in lowercase, typed with capitals", async () => {
    A.users = [person(7, "dana@acme.com")];
    expect((await ensureIdentity("Dana@Acme.COM", "Dana")).pk).toBe(7);
    expect(posts()).toEqual([]);
  });

  it("stored with capitals, typed with the same capitals: the stored case is kept", async () => {
    A.users = [person(7, "Dana@Acme.com")];
    expect(await ensureIdentity("Dana@Acme.com", "Dana")).toEqual({ subject: "sub-7", pk: 7, email: "Dana@Acme.com", username: "Dana@Acme.com" });
    expect(posts()).toEqual([]);
  });

  it.each([
    ["dana@acme.com"], ["DANA@acme.com"], ["dAnA@aCmE.cOm"],
  ])("stored as Dana@Acme.com, typed %j: the same person, found by the search", async (typed) => {
    A.users = [person(7, "Dana@Acme.com")];
    expect(await ensureIdentity(typed, "Dana")).toEqual({ subject: "sub-7", pk: 7, email: "Dana@Acme.com", username: "Dana@Acme.com" });
    expect(posts()).toEqual([]);
  });

  it("the stored address is never rewritten by a lookup", async () => {
    A.users = [person(7, "Dana@Acme.com")];
    await ensureIdentity("dana@acme.com", "Dana");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(A.users[0].email).toBe("Dana@Acme.com");
  });
});

describe("the search brings other people, and none of them is ever this person", () => {
  it.each([
    ["a longer address that contains it", person(8, "xdana@acme.com")],
    ["an address it is the start of", person(8, "dana@acme.com.au")],
    ["somebody whose NAME is the address", person(8, "other@else.com", { name: "dana@acme.com" })],
    ["somebody whose USERNAME is the address", person(8, "other@else.com", { username: "dana@acme.com" })],
    ["a row with no email at all", { uuid: "sub-8", pk: 8, username: "dana@acme.com", email: undefined as any }],
  ])("%s: a new identity is created, that row is not returned", async (_name, other) => {
    A.users = [other as AkUser];
    const out = await ensureIdentity("Dana@Acme.com", "Dana");
    expect(out.pk).toBe(101);
    expect(posts()).toHaveLength(1);
  });

  it("the right person is picked out from among the others", async () => {
    A.users = [person(8, "xdana@acme.com"), person(9, "other@else.com", { name: "dana@acme.com" }), person(7, "Dana@Acme.com")];
    expect((await ensureIdentity("dana@acme.com", "Dana")).pk).toBe(7);
    expect(posts()).toEqual([]);
  });

  it("a loose exact filter that answers with everybody still returns only the exact address", async () => {
    A.looseEmailFilter = true;
    A.users = [person(8, "other@else.com"), person(7, "dana@acme.com")];
    expect((await ensureIdentity("dana@acme.com", "Dana")).pk).toBe(7);
  });

  it("padding around a stored address does not make it another person", async () => {
    A.users = [person(7, " Dana@Acme.com ")];
    expect((await ensureIdentity("dana@acme.com", "Dana")).pk).toBe(7);
  });
});

describe("the search is followed across pages, up to a limit", () => {
  const crowd = (n: number) => Array.from({ length: n }, (_v, i) => person(1000 + i, `dana@acme.com.x${i}`));

  it("the person on the second page is found", async () => {
    A.pageSize = 2;
    A.users = [...crowd(3), person(7, "Dana@Acme.com")];
    expect((await ensureIdentity("dana@acme.com", "Dana")).pk).toBe(7);
    expect(gets().filter((p) => p.includes("search="))).toEqual([
      "/core/users/?search=dana%40acme.com&page_size=100&page=1",
      "/core/users/?search=dana%40acme.com&page_size=100&page=2",
    ]);
    expect(posts()).toEqual([]);
  });

  it("the person on the fifth page is found; reading stops at the page that has them", async () => {
    A.pageSize = 1;
    A.users = [...crowd(4), person(7, "Dana@Acme.com"), ...crowd(3)];
    expect((await ensureIdentity("dana@acme.com", "Dana")).pk).toBe(7);
    expect(gets().filter((p) => p.includes("search="))).toHaveLength(5);
  });

  it("no sixth page is read", async () => {
    A.pageSize = 1;
    A.users = crowd(9);
    await ensureIdentity("dana@acme.com", "Dana");
    expect(gets().filter((p) => p.includes("search="))).toHaveLength(5);
  });

  it("a single page with no next is read once", async () => {
    A.users = crowd(3);
    await ensureIdentity("dana@acme.com", "Dana");
    expect(gets().filter((p) => p.includes("search="))).toHaveLength(1);
  });
});

describe("a lookup that failed is never 'nobody there'", () => {
  it("a failed search throws and creates nothing", async () => {
    A.failSearch = true;
    await expect(ensureIdentity("dana@acme.com", "Dana")).rejects.toThrow(/authentik/);
    expect(posts()).toEqual([]);
  });

  it("a refused create throws", async () => {
    A.failCreate = true;
    await expect(ensureIdentity("dana@acme.com", "Dana")).rejects.toThrow(/authentik/);
  });

  it.each([[""], ["   "], [undefined as any], [null as any]])("an empty address (%j) is refused before any request", async (email) => {
    A.users = [{ uuid: "sub-svc", pk: 1, email: "", username: "ak-outpost" }];
    await expect(ensureIdentity(email, "Nobody")).rejects.toThrow(/email/);
    expect(calls).toEqual([]);
  });
});

describe("findIdentityByEmail: the same lookup, and it never creates", () => {
  it.each([
    ["dana@acme.com", "dana@acme.com"],
    ["Dana@Acme.com", "dana@acme.com"],
    ["dana@acme.com", "Dana@Acme.com"],
    ["  dana@acme.com ", "Dana@Acme.com"],
  ])("asked for %j, stored as %j: found", async (asked, stored) => {
    A.users = [person(7, stored)];
    expect(await findIdentityByEmail(asked)).toEqual({ subject: "sub-7", pk: 7, email: stored, username: stored });
    expect(posts()).toEqual([]);
  });

  it("nobody holds it: null, and nothing is created", async () => {
    A.users = [person(8, "xdana@acme.com")];
    expect(await findIdentityByEmail("dana@acme.com")).toBeNull();
    expect(posts()).toEqual([]);
  });

  it("an empty address matches nobody, a service account with no email included", async () => {
    A.looseEmailFilter = true;
    A.users = [{ uuid: "sub-svc", pk: 1, email: "", username: "ak-outpost" }];
    expect(await findIdentityByEmail("")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a failed read throws: 'could not ask' is not 'free to use'", async () => {
    A.failSearch = true;
    await expect(findIdentityByEmail("dana@acme.com")).rejects.toThrow(/authentik/);
  });
});
