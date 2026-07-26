import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import {
  oidcConfig,
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
  discover,
  safeReturnTo,
  __resetOidcDiscoveryCache,
  type Discovery,
} from "../lib/oidc-server";

const CFG = { issuer: "https://auth-dev.gotcha.co.il/application/o/gotcha", clientId: "gotcha-app", redirectUri: "https://dev.gotcha.co.il/api/auth/callback" };
const DISCO: Discovery = {
  authorization_endpoint: "https://auth-dev.gotcha.co.il/application/o/authorize/",
  token_endpoint: "https://auth-dev.gotcha.co.il/application/o/token/",
};

beforeEach(() => __resetOidcDiscoveryCache());

describe("oidcConfig", () => {
  it("derives the backend callback from APP_ORIGIN (/api/auth/callback)", () => {
    const c = oidcConfig({ OIDC_ISSUER: "https://auth-dev.gotcha.co.il/application/o/gotcha/", OIDC_CLIENT_ID: "gotcha-app", APP_ORIGIN: "https://dev.gotcha.co.il" } as any);
    expect(c.redirectUri).toBe("https://dev.gotcha.co.il/api/auth/callback");
    expect(c.issuer).toBe("https://auth-dev.gotcha.co.il/application/o/gotcha"); // trailing slash stripped
  });
  it("throws when required config is missing", () => {
    expect(() => oidcConfig({ OIDC_CLIENT_ID: "x", APP_ORIGIN: "https://d" } as any)).toThrow(/OIDC_ISSUER/);
    expect(() => oidcConfig({ OIDC_ISSUER: "https://i", OIDC_CLIENT_ID: "x" } as any)).toThrow(/APP_ORIGIN/);
  });
});

describe("generatePkce", () => {
  it("produces a base64url verifier and a correct S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
  it("is unique per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds a spec-correct S256 authorize URL", () => {
    const url = new URL(buildAuthorizeUrl(DISCO, CFG, { state: "st", nonce: "no", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe(DISCO.authorization_endpoint.replace(/\/$/, "") + "/");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("gotcha-app");
    expect(q.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe("ch");
    expect(q.get("state")).toBe("st");
    expect(q.get("nonce")).toBe("no");
    expect(q.get("scope")).toContain("offline_access");
  });
});

describe("safeReturnTo (open-redirect guard)", () => {
  it("keeps root-relative paths, rejects everything else", () => {
    expect(safeReturnTo("/ai-studio?tab=tools")).toBe("/ai-studio?tab=tools");
    for (const bad of ["", "//evil.com", "https://evil.com", "http://x", "\\evil", 42 as any, null as any]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});

describe("discover + exchangeCode (injected fetch)", () => {
  it("caches discovery and only fetches once", async () => {
    let calls = 0;
    const f = (async () => { calls++; return { ok: true, json: async () => DISCO } as any; }) as any;
    expect((await discover(CFG, f)).token_endpoint).toBe(DISCO.token_endpoint);
    await discover(CFG, f);
    expect(calls).toBe(1);
  });
  it("exchanges the code with PKCE verifier and rejects a bad response", async () => {
    const good = (async (_u: string, init: any) => {
      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toBe("v1");
      expect(body.get("redirect_uri")).toBe(CFG.redirectUri);
      return { ok: true, json: async () => ({ access_token: "AT", refresh_token: "RT", id_token: "IT", expires_in: 1800 }) } as any;
    }) as any;
    const t = await exchangeCode(DISCO, CFG, { code: "c", verifier: "v1" }, good);
    expect(t.access_token).toBe("AT");
    const bad = (async () => ({ ok: false, status: 400 } as any)) as any;
    await expect(exchangeCode(DISCO, CFG, { code: "c", verifier: "v1" }, bad)).rejects.toThrow(/token exchange failed/);
  });
});
