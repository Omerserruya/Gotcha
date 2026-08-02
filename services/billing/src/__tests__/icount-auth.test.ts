/**
 * iCount authentication invariants.
 *
 * These are security tests, not behaviour tests: each one pins a property that
 * would be a credential leak or an unauthenticated-payment-call bug if it
 * regressed. They are deliberately blunt (including source-text assertions),
 * because "we removed the password path" has to stay true under later edits.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertIcountConfig,
  authHeaders,
  icountApiToken,
  icountPaymentPageId,
  redactIcount,
  sanitizeIcountError,
  isMock,
} from "../providers/icount-config";

const REPO = join(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const ORIGINAL = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("ICOUNT_")) delete process.env[k];
  process.env.ICOUNT_MODE = "mock";
});
afterAll(() => {
  process.env = ORIGINAL;
});

describe("fails closed without an API token", () => {
  it("refuses to produce a token", () => {
    expect(() => icountApiToken()).toThrow(/ICOUNT_API_TOKEN is not configured/);
  });

  it("refuses to build auth headers, so no unauthenticated request can be sent", () => {
    expect(() => authHeaders()).toThrow(/ICOUNT_API_TOKEN is not configured/);
  });

  it("refuses to start in live mode", () => {
    process.env.ICOUNT_MODE = "live";
    expect(() => assertIcountConfig()).toThrow(/requires ICOUNT_API_TOKEN/);
  });

  it("still starts in mock mode, which makes no network calls and holds no credentials", () => {
    process.env.ICOUNT_MODE = "mock";
    expect(() => assertIcountConfig()).not.toThrow();
  });

  it("treats whitespace as missing rather than sending a blank Authorization header", () => {
    process.env.ICOUNT_API_TOKEN = "   ";
    expect(() => icountApiToken()).toThrow(/not configured/);
  });
});

describe("no legacy credential path exists", () => {
  it("does not read CID, username or password", () => {
    process.env.ICOUNT_CID = "12345";
    process.env.ICOUNT_USER = "someone";
    process.env.ICOUNT_PASS = "hunter2";
    // Legacy credentials present and complete: still refuses, because there is
    // no fallback to fall back TO.
    expect(() => icountApiToken()).toThrow(/ICOUNT_API_TOKEN is not configured/);
    process.env.ICOUNT_MODE = "live";
    expect(() => assertIcountConfig()).toThrow(/requires ICOUNT_API_TOKEN/);
  });

  it("mentions no legacy credential variable anywhere in the provider", () => {
    for (const f of ["services/billing/src/providers/icount-config.ts", "services/billing/src/providers/icount.provider.ts"]) {
      const code = read(f);
      expect(code, `${f} must not reference ICOUNT_CID`).not.toContain("ICOUNT_CID");
      expect(code, `${f} must not reference ICOUNT_USER`).not.toContain("ICOUNT_USER");
      expect(code, `${f} must not reference ICOUNT_PASS`).not.toContain("ICOUNT_PASS");
    }
  });

  it("never puts credentials in a request body", () => {
    const code = read("services/billing/src/providers/icount.provider.ts");
    // The old helper spread { cid, user, pass } into every payload.
    expect(code).not.toMatch(/\bcid\b\s*[,:]/);
    expect(code).not.toMatch(/\bpass\b\s*[,:]/);
  });

  it("exposes no auth-mode switch to get wrong", () => {
    // A setting whose only legal value is the one thing the code does is not
    // configuration, it is a chance to misconfigure something with no
    // alternative. Setting it must therefore change nothing.
    process.env.ICOUNT_API_TOKEN = "tok_live_abcdefghijklmnop";
    (process.env as any).ICOUNT_AUTH_MODE = "user_pass";
    expect(icountApiToken()).toBe("tok_live_abcdefghijklmnop");
    expect(() => assertIcountConfig()).not.toThrow();
    for (const f of ["services/billing/src/providers/icount-config.ts", ".env.example", "docker-compose.yml", "docker-compose.prod.yml"]) {
      expect(read(f).replace(/^.*deliberately no ICOUNT_AUTH_MODE.*$/m, ""), `${f} must not define an auth mode`).not.toMatch(
        /ICOUNT_AUTH_MODE\s*[:=]/,
      );
    }
  });
});

describe("token transport", () => {
  it("sends the token as an Authorization Bearer header, never in the body or URL", () => {
    process.env.ICOUNT_API_TOKEN = "tok_live_abcdefghijklmnop";
    const headers = authHeaders();
    expect(headers.Authorization).toBe("Bearer tok_live_abcdefghijklmnop");
    expect(headers["Content-Type"]).toBe("application/json");

    // The wire-level calls live in the typed client now; the rule is unchanged.
    const code = read("services/billing/src/providers/icount-client.ts");
    // The token must never be interpolated into a request path.
    expect(code).not.toMatch(/\$\{[^}]*[Tt]oken[^}]*\}\/?`?\s*,?\s*$/m);
    expect(code).toContain("headers: authHeaders()");
    // ...nor into a request body, where it would land in provider-side logs.
    expect(code).not.toMatch(/api_?token|sid:|access_token:/i);
  });
});

describe("the API token never reaches the browser", () => {
  it("is not exposed through any NEXT_PUBLIC variable", () => {
    for (const f of [".env.example", "docker-compose.yml", "docker-compose.prod.yml"]) {
      expect(read(f), `${f} must not expose iCount config to the browser`).not.toMatch(
        /NEXT_PUBLIC_ICOUNT/,
      );
    }
  });

  it("is absent from the entire frontend source tree", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== "node_modules" && entry !== ".next") walk(p);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
        const code = readFileSync(p, "utf8");
        if (/ICOUNT_API_TOKEN|ICOUNT_PASS|ICOUNT_CID/.test(code)) hits.push(p);
      }
    };
    walk(join(REPO, "frontend/src"));
    expect(hits, `frontend must not reference iCount credentials: ${hits.join(", ")}`).toEqual([]);
  });

  it("is not part of any provider return value", async () => {
    process.env.ICOUNT_API_TOKEN = "tok_live_abcdefghijklmnop";
    const { icountProvider } = await import("../providers/icount.provider");
    const tok = await icountProvider.tokenizeAndVerify({ pageToken: "pt_dev" });
    expect(JSON.stringify(tok)).not.toContain("tok_live_abcdefghijklmnop");
  });
});

describe("the API token never reaches a log or an error", () => {
  const TOKEN = "tok_live_abcdefghijklmnop";
  beforeEach(() => {
    process.env.ICOUNT_API_TOKEN = TOKEN;
  });

  it("is stripped from an axios-shaped error carrying the Authorization header", () => {
    // This is the real leak path: axios attaches the full request config,
    // headers included, to every error it throws.
    const axiosErr: any = new Error("Request failed with status code 401");
    axiosErr.config = { headers: { Authorization: `Bearer ${TOKEN}` }, url: "https://api.icount.co.il/api/v3.php/x" };
    axiosErr.response = { status: 401, data: { status: false, reason: "unauthorized" } };

    const safe = sanitizeIcountError("cc/charge", axiosErr);
    const serialized = `${safe.message}\n${safe.stack ?? ""}\n${JSON.stringify(safe)}`;
    expect(serialized).not.toContain(TOKEN);
    // Still diagnostically useful.
    expect(safe.message).toContain("cc/charge");
    expect(safe.message).toContain("401");
  });

  it("is stripped when it appears bare inside an arbitrary logged value", () => {
    const out = JSON.stringify(redactIcount({ note: `token is ${TOKEN}`, nested: { t: TOKEN } }));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[REDACTED]");
  });

  it("is stripped when it appears as a Bearer header in a logged object", () => {
    const out = JSON.stringify(redactIcount({ headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(out).not.toContain(TOKEN);
  });

  it("does not echo the token back in the not-configured error", () => {
    delete process.env.ICOUNT_API_TOKEN;
    try {
      icountApiToken();
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe("the Page ID is configuration, not a credential", () => {
  it("resolves without any token present", () => {
    process.env.ICOUNT_PAYMENT_PAGE_ID = "123456";
    expect(icountPaymentPageId()).toBe("123456");
    expect(() => icountApiToken()).toThrow(); // still no token - unrelated concerns
  });

  it("is absent when unset rather than defaulting to something", () => {
    expect(icountPaymentPageId()).toBeNull();
  });

  it("is never sent as an authentication header", () => {
    process.env.ICOUNT_PAYMENT_PAGE_ID = "123456";
    process.env.ICOUNT_API_TOKEN = "tok_live_abcdefghijklmnop";
    expect(JSON.stringify(authHeaders())).not.toContain("123456");
  });

  it("is not committed with a real value", () => {
    expect(read(".env.example")).toMatch(/^ICOUNT_PAYMENT_PAGE_ID=$/m);
    expect(read(".env.example")).toMatch(/^ICOUNT_API_TOKEN=$/m);
  });
});

describe("live charging stays disabled by default", () => {
  it("defaults to mock mode when nothing is configured", () => {
    expect(isMock()).toBe(true);
  });

  it("ships mock mode and no live acknowledgement in .env.example", () => {
    const env = read(".env.example");
    expect(env).toMatch(/^ICOUNT_MODE=mock$/m);
    expect(env).toMatch(/^ICOUNT_ALLOW_LIVE=false$/m);
  });

  it("defaults both compose files to mock", () => {
    for (const f of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      expect(read(f)).toMatch(/ICOUNT_MODE:\s*\$\{ICOUNT_MODE:-mock\}/);
    }
  });
});
