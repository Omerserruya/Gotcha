/**
 * Where a checkout's bearer credential lives once the email has been opened.
 *
 * The continuation token can show a plan and price, open a payment session and
 * ask the server to charge. It has to arrive in a URL because it comes from an
 * email - but a URL persists in history, in autocomplete and in access logs,
 * and the previous fix (sessionStorage) simply moved it somewhere any script
 * on the page could read.
 *
 * So the first authorized request hands it to an HttpOnly cookie scoped to
 * /api/checkout, and the browser carries it after that. These cover the
 * handoff at its chokepoint, `authorizeCheckout`, which every checkout route
 * goes through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const resolveContinuationLink = vi.hoisted(() => vi.fn());
const markLinkUsed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const findFirst = vi.hoisted(() => vi.fn());

vi.mock("../services/continuation-link.service", () => ({ resolveContinuationLink, markLinkUsed }));
vi.mock("@chatcenter/shared", () => ({
  prisma: { user: { findFirst } },
  authenticate: vi.fn(),
  resolveTenant: vi.fn(),
}));

import { authorizeCheckout, setCheckoutCookie, clearCheckoutCookie } from "../lib/checkout-auth";

const CHECKOUT = { id: "co_1", tenantId: "t_1", reference: "chk_abc" };
const TOKEN = "tok_live_secret";
const HOUR = new Date(Date.now() + 3_600_000);

function res() {
  const headers: string[] = [];
  return { append: (_k: string, v: string) => headers.push(v), headers };
}
function req(over: Record<string, unknown> = {}) {
  return { query: {}, body: {}, headers: {}, ...over } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  markLinkUsed.mockResolvedValue(undefined);
});

describe("the first request, with the token still in the open", () => {
  beforeEach(() => {
    resolveContinuationLink.mockResolvedValue({ ok: true, checkout: { id: "co_1" }, link: { id: "l1", expiresAt: HOUR } });
  });

  it("authorizes and hands the token to a cookie", async () => {
    const r = res();
    const auth = await authorizeCheckout(req({ query: { token: TOKEN } }), CHECKOUT, r as never);

    expect(auth).toEqual({ ok: true, via: "continuation_link" });
    expect(r.headers).toHaveLength(1);
    expect(r.headers[0]).toContain(`gc_co_chk_abc=${TOKEN}`);
  });

  it("makes the cookie unreadable by script and unattached to other requests", async () => {
    const r = res();
    await authorizeCheckout(req({ query: { token: TOKEN } }), CHECKOUT, r as never);

    expect(r.headers[0]).toContain("HttpOnly");
    expect(r.headers[0]).toContain("Path=/api/checkout");
    expect(r.headers[0]).toContain("SameSite=Lax");
  });

  it("expires the cookie with the link, not later", async () => {
    // A cookie outliving the offer it belongs to would keep authorizing after
    // the link was deliberately time-boxed.
    const r = res();
    await authorizeCheckout(req({ query: { token: TOKEN } }), CHECKOUT, r as never);

    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers[0])![1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  it("accepts the token from a POST body too", async () => {
    const r = res();
    const auth = await authorizeCheckout(req({ body: { token: TOKEN } }), CHECKOUT, r as never);
    expect(auth.ok).toBe(true);
    expect(r.headers[0]).toContain("gc_co_chk_abc=");
  });
});

describe("every request after the handoff", () => {
  beforeEach(() => {
    resolveContinuationLink.mockResolvedValue({ ok: true, checkout: { id: "co_1" }, link: { id: "l1", expiresAt: HOUR } });
  });

  it("authorizes from the cookie with no token in the URL", async () => {
    const auth = await authorizeCheckout(
      req({ headers: { cookie: `gc_co_chk_abc=${TOKEN}` } }),
      CHECKOUT,
      res() as never,
    );
    expect(auth).toEqual({ ok: true, via: "continuation_link" });
    expect(resolveContinuationLink).toHaveBeenCalledWith(TOKEN);
  });

  it("does not re-issue a cookie it already has", async () => {
    const r = res();
    await authorizeCheckout(req({ headers: { cookie: `gc_co_chk_abc=${TOKEN}` } }), CHECKOUT, r as never);
    expect(r.headers).toHaveLength(0);
  });

  it("picks the cookie out of a header holding several", async () => {
    const cookie = `other=1; gc_co_chk_abc=${TOKEN}; session=xyz`;
    const auth = await authorizeCheckout(req({ headers: { cookie } }), CHECKOUT, res() as never);
    expect(auth.ok).toBe(true);
    expect(resolveContinuationLink).toHaveBeenCalledWith(TOKEN);
  });

  it("ignores a cookie belonging to a different checkout", async () => {
    // Scoped per reference precisely so one checkout's cookie cannot pay for
    // another.
    const auth = await authorizeCheckout(
      req({ headers: { cookie: `gc_co_chk_OTHER=${TOKEN}` } }),
      CHECKOUT,
      res() as never,
    );
    expect(auth.ok).toBe(false);
    expect(resolveContinuationLink).not.toHaveBeenCalled();
  });
});

describe("a cookie that has stopped being good", () => {
  it("is cleared rather than left to fail every later request", async () => {
    resolveContinuationLink.mockResolvedValue({ ok: false });
    const r = res();
    const auth = await authorizeCheckout(req({ headers: { cookie: "gc_co_chk_abc=stale" } }), CHECKOUT, r as never);

    expect(auth.ok).toBe(false);
    expect(r.headers[0]).toContain("Max-Age=0");
  });

  it("gives way to a freshly emailed link opened over it", async () => {
    // Someone asks for a new link after the first expires. The stale cookie
    // must not shadow the token they just clicked.
    resolveContinuationLink.mockImplementation(async (t: string) =>
      t === "fresh" ? { ok: true, checkout: { id: "co_1" }, link: { id: "l2", expiresAt: HOUR } } : { ok: false },
    );
    const r = res();
    const auth = await authorizeCheckout(
      req({ headers: { cookie: "gc_co_chk_abc=stale" }, query: { token: "fresh" } }),
      CHECKOUT,
      r as never,
    );

    expect(auth).toEqual({ ok: true, via: "continuation_link" });
    expect(r.headers.some((h) => h.includes("gc_co_chk_abc=fresh"))).toBe(true);
  });

  it("does not authorize a token for someone else's checkout", async () => {
    resolveContinuationLink.mockResolvedValue({ ok: true, checkout: { id: "co_OTHER" }, link: { id: "l1", expiresAt: HOUR } });
    const auth = await authorizeCheckout(req({ query: { token: TOKEN } }), CHECKOUT, res() as never);
    expect(auth.ok).toBe(false);
    expect(markLinkUsed).not.toHaveBeenCalled();
  });
});

describe("the signed-in paths, which the cookie must not disturb", () => {
  it("still authorizes a platform admin", async () => {
    const auth = await authorizeCheckout(req({ user: { role: "SYSTEM_ADMIN" } }), CHECKOUT, res() as never);
    expect(auth).toEqual({ ok: true, via: "platform_admin" });
  });

  it("still authorizes a member of the owning tenant", async () => {
    findFirst.mockResolvedValue({ id: "u_1" });
    const auth = await authorizeCheckout(req({ user: { userId: "u_1", role: "ADMIN" } }), CHECKOUT, res() as never);
    expect(auth).toEqual({ ok: true, via: "tenant_member" });
  });

  it("still refuses a signed-in stranger", async () => {
    findFirst.mockResolvedValue(null);
    const auth = await authorizeCheckout(req({ user: { userId: "u_9", role: "ADMIN" } }), CHECKOUT, res() as never);
    expect(auth.ok).toBe(false);
  });

  it("still refuses an anonymous caller who knows only the reference", async () => {
    // Knowing the reference is not authorization: it travels through a browser
    // URL and a third party.
    const auth = await authorizeCheckout(req(), CHECKOUT, res() as never);
    expect(auth.ok).toBe(false);
  });
});

describe("cookie mechanics", () => {
  it("writes nothing for a link that has already expired", () => {
    const r = res();
    setCheckoutCookie(r as never, "chk_abc", TOKEN, new Date(Date.now() - 1000));
    expect(r.headers).toHaveLength(0);
  });

  it("keeps the cookie name inside the grammar even if a reference does not", () => {
    const r = res();
    setCheckoutCookie(r as never, "chk a;b=c", TOKEN, HOUR);
    expect(r.headers[0].startsWith("gc_co_chkabc=")).toBe(true);
  });

  it("is Secure by default, because the deployment is HTTPS behind a proxy", () => {
    // NODE_ENV is a poor signal for this: dev is served over TLS too, and
    // getting it wrong puts a payment credential on the wire in the clear.
    delete process.env.CHECKOUT_COOKIE_INSECURE;
    const r = res();
    setCheckoutCookie(r as never, "chk_abc", TOKEN, HOUR);
    expect(r.headers[0]).toContain("Secure");
  });

  it("stays Secure even though the proxy reports http", () => {
    // TLS terminates at the edge and nginx forwards $scheme, so the header
    // says "http" on a request the customer made over HTTPS. Trusting it
    // would drop Secure on every production request.
    const r = res();
    setCheckoutCookie(r as never, "chk_abc", TOKEN, HOUR);
    expect(r.headers[0]).toContain("Secure");
  });

  it("drops Secure only when plaintext is explicitly asked for", () => {
    // Otherwise local http development cannot hold the cookie at all.
    process.env.CHECKOUT_COOKIE_INSECURE = "true";
    try {
      const r = res();
      setCheckoutCookie(r as never, "chk_abc", TOKEN, HOUR);
      expect(r.headers[0]).not.toContain("Secure");
    } finally {
      delete process.env.CHECKOUT_COOKIE_INSECURE;
    }
  });

  it("clears with the same path, or the browser keeps the old one", () => {
    const r = res();
    clearCheckoutCookie(r as never, "chk_abc");
    expect(r.headers[0]).toContain("Path=/api/checkout");
    expect(r.headers[0]).toContain("Max-Age=0");
  });
});
