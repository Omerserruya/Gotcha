/**
 * The rules that stop a domain migration becoming an incident.
 *
 * Two of these are not hypothetical. Twenty call sites built customer-facing
 * links as `process.env.FRONTEND_URL || "http://localhost:3000"`, so an unset
 * variable in production mailed localhost links to customers and logged
 * nothing. One fell back to the marketing domain, sending an authenticated user
 * away from the app. Both are covered below.
 */
import { describe, it, expect } from "vitest";
import {
  publicOrigin,
  publicUrl,
  oauthRedirectUri,
  webhookUrl,
  normalisePublicOrigin,
  publicUrlDiagnostics,
  assertPublicUrlsReady,
  PublicUrlError,
} from "../app-urls";

const PROD = {
  NODE_ENV: "production",
  PUBLIC_APP_URL: "https://app.gotcha.co.il",
  PUBLIC_MARKETING_URL: "https://gotcha.co.il",
  PUBLIC_AUTH_URL: "https://auth.gotcha.co.il",
  PUBLIC_HELP_URL: "https://help.gotcha.co.il",
  PUBLIC_VOICE_URL: "https://voice.gotcha.co.il",
} as NodeJS.ProcessEnv;

describe("the five surfaces stay separate", () => {
  it("resolves each canonical origin", () => {
    expect(publicOrigin("app", PROD)).toBe("https://app.gotcha.co.il");
    expect(publicOrigin("marketing", PROD)).toBe("https://gotcha.co.il");
    expect(publicOrigin("auth", PROD)).toBe("https://auth.gotcha.co.il");
    expect(publicOrigin("help", PROD)).toBe("https://help.gotcha.co.il");
    expect(publicOrigin("voice", PROD)).toBe("https://voice.gotcha.co.il");
  });

  it("the app origin is never the marketing origin", () => {
    expect(publicOrigin("app", PROD)).not.toBe(publicOrigin("marketing", PROD));
  });

  it("an OAuth redirect URI is always on the application origin", () => {
    expect(oauthRedirectUri("/api/connectors/shopify/oauth/callback", PROD))
      .toBe("https://app.gotcha.co.il/api/connectors/shopify/oauth/callback");
  });

  it("a webhook URL is always on the application origin, never voice or marketing", () => {
    const u = webhookUrl("/api/shopify-chat/webhooks/app-uninstalled", PROD);
    expect(u).toBe("https://app.gotcha.co.il/api/shopify-chat/webhooks/app-uninstalled");
    expect(u).not.toContain("voice.gotcha.co.il");
    expect(u.startsWith("https://gotcha.co.il")).toBe(false);
  });
});

describe("production never falls back to a development default", () => {
  it("THE bug: an unset app URL throws instead of yielding localhost", () => {
    // This is what mailed `http://localhost:3000/...` to customers.
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => publicOrigin("app", env)).toThrow(PublicUrlError);
    try {
      publicOrigin("app", env);
    } catch (e: any) {
      expect(e.message).not.toContain("localhost");
      expect(e.message).toContain("PUBLIC_APP_URL");
    }
  });

  it("an unset OPTIONAL surface still refuses to emit localhost in production", () => {
    const env = { ...PROD, PUBLIC_HELP_URL: "" } as NodeJS.ProcessEnv;
    expect(() => publicOrigin("help", env)).toThrow(/refusing to fall back/);
  });

  it("development does default, because refusing to boot a laptop helps nobody", () => {
    expect(publicOrigin("app", { NODE_ENV: "development" } as NodeJS.ProcessEnv))
      .toBe("http://localhost:3000");
  });

  it("http is refused in production and allowed locally", () => {
    expect(() => publicOrigin("app", { NODE_ENV: "production", PUBLIC_APP_URL: "http://app.gotcha.co.il" } as any))
      .toThrow(/https in production/);
    expect(publicOrigin("app", { NODE_ENV: "development", PUBLIC_APP_URL: "http://localhost:3000" } as any))
      .toBe("http://localhost:3000");
  });

  it("startup assertion fails loudly rather than booting a broken deployment", () => {
    expect(() => assertPublicUrlsReady({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/unusable/);
    expect(() => assertPublicUrlsReady(PROD)).not.toThrow();
  });
});

describe("legacy variables are honoured so one deployment cannot disagree with itself", () => {
  it("falls back through APP_ORIGIN then APP_PUBLIC_URL then FRONTEND_URL", () => {
    expect(publicOrigin("app", { NODE_ENV: "production", APP_ORIGIN: "https://app.gotcha.co.il" } as any))
      .toBe("https://app.gotcha.co.il");
    expect(publicOrigin("app", { NODE_ENV: "production", APP_PUBLIC_URL: "https://app.gotcha.co.il" } as any))
      .toBe("https://app.gotcha.co.il");
    expect(publicOrigin("app", { NODE_ENV: "production", FRONTEND_URL: "https://app.gotcha.co.il" } as any))
      .toBe("https://app.gotcha.co.il");
  });

  it("the canonical variable wins over a stale legacy one", () => {
    const env = {
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.gotcha.co.il",
      FRONTEND_URL: "https://dev.gotcha.co.il",
    } as NodeJS.ProcessEnv;
    expect(publicOrigin("app", env)).toBe("https://app.gotcha.co.il");
  });
});

describe("the origin can never come from the caller", () => {
  it("rejects an absolute URL passed as a path", () => {
    expect(() => publicUrl("app", "https://evil.example/steal", {}, PROD)).toThrow(PublicUrlError);
  });

  it("rejects a protocol-relative path", () => {
    expect(() => publicUrl("app", "//evil.example/steal", {}, PROD)).toThrow(/protocol-relative/);
  });

  it("rejects a scheme smuggled into a path", () => {
    expect(() => publicUrl("app", "/javascript:alert(1)", {}, PROD)).toThrow(/scheme/);
  });

  it("rejects a relative path with no leading slash", () => {
    expect(() => publicUrl("app", "settings", {}, PROD)).toThrow(/must start with/);
  });

  it("a lookalike host in configuration is still just a host, not our origin", () => {
    // `endsWith("gotcha.co.il")` would accept this. Exact origins do not.
    const built = publicUrl("app", "/settings", {}, PROD);
    expect(new URL(built).hostname).toBe("app.gotcha.co.il");
  });

  it("query parameters cannot move the origin", () => {
    const u = publicUrl("app", "/settings", { next: "https://evil.example" }, PROD);
    expect(new URL(u).origin).toBe("https://app.gotcha.co.il");
  });
});

describe("origin normalisation", () => {
  it("strips a trailing slash so paths never double up", () => {
    expect(publicOrigin("app", { ...PROD, PUBLIC_APP_URL: "https://app.gotcha.co.il/" } as any))
      .toBe("https://app.gotcha.co.il");
    expect(publicUrl("app", "/settings", {}, { ...PROD, PUBLIC_APP_URL: "https://app.gotcha.co.il/" } as any))
      .toBe("https://app.gotcha.co.il/settings");
  });

  it("rejects a wildcard", () => {
    expect(() => normalisePublicOrigin("https://*.gotcha.co.il", "X", true)).toThrow(/wildcard/);
  });

  it("rejects an origin carrying a path or query", () => {
    expect(() => normalisePublicOrigin("https://app.gotcha.co.il/app", "X", true)).toThrow(/bare origin/);
    expect(() => normalisePublicOrigin("https://app.gotcha.co.il?x=1", "X", true)).toThrow(/bare origin/);
  });

  it("rejects embedded credentials", () => {
    expect(() => normalisePublicOrigin("https://u:p@app.gotcha.co.il", "X", true)).toThrow(/credentials/);
  });

  it("drops a default port and keeps a non-default one", () => {
    expect(normalisePublicOrigin("https://app.gotcha.co.il:443", "X", true)).toBe("https://app.gotcha.co.il");
    expect(normalisePublicOrigin("http://localhost:3000", "X", false)).toBe("http://localhost:3000");
  });
});

describe("startup diagnostics", () => {
  it("reports every surface and where it came from", () => {
    const d = publicUrlDiagnostics(PROD);
    expect(d).toHaveLength(5);
    expect(d.find((x) => x.surface === "app")).toMatchObject({
      origin: "https://app.gotcha.co.il",
      source: "PUBLIC_APP_URL",
      error: null,
    });
  });

  it("names the unresolved surface instead of hiding it", () => {
    const d = publicUrlDiagnostics({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(d.find((x) => x.surface === "app")?.error).toMatch(/PUBLIC_APP_URL/);
  });

  it("reports origins only - there is no secret to leak, and nothing else is read", () => {
    const d = publicUrlDiagnostics({ ...PROD, AUTHENTIK_API_TOKEN: "secret-token" } as any);
    expect(JSON.stringify(d)).not.toContain("secret-token");
  });
});
