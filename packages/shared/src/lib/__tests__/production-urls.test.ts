/**
 * Production URL guard.
 *
 * The canonical production hostnames are:
 *
 *   gotcha.co.il        marketing only
 *   app.gotcha.co.il    application, public API, OAuth callbacks, webhooks
 *   auth.gotcha.co.il   Authentik
 *   help.gotcha.co.il   Help Center
 *   voice.gotcha.co.il  Twilio HTTP callbacks and media-stream WebSocket
 *
 * Every one of these has already been wrong once. The application surface sat
 * on the marketing apex; the Help Center's sign-in button pointed at Dev; the
 * Twilio callbacks were derived from the application origin because they
 * shared one variable. None of those failed loudly - a webhook on the wrong
 * host answers with someone else's 404, and the call simply goes quiet.
 *
 * So this file asserts the mapping over the real production artefacts rather
 * than over a description of them. It reads the committed manifests, compose
 * file and nginx template; it never reads .env.prod, which is untracked and
 * holds secrets.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveAppPublicUrl, resolveVoicePublicUrl, AppOriginError } from "../app-origins";

// ─── Repo root: walk up to the workspace package.json ────────────────
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  throw new Error("workspace root not found");
}
const ROOT = repoRoot();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const APP = "https://app.gotcha.co.il";
const VOICE = "https://voice.gotcha.co.il";
const AUTH_HOST = "auth.gotcha.co.il";
const HELP_HOST = "help.gotcha.co.il";

describe("production hostname model", () => {
  // ── The Shopify Chat production manifest ───────────────────────────
  describe("Shopify Chat manifest (shopify-app/shopify.app.toml)", () => {
    const toml = read("shopify-app/shopify.app.toml");
    const urls = [...toml.matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);

    it("has no URL on the marketing apex", () => {
      const apex = urls.filter((u) => new URL(u).host === "gotcha.co.il");
      expect(apex, "marketing apex serves no application routes").toEqual([]);
    });

    it("has no Dev URL", () => {
      expect(urls.filter((u) => new URL(u).host === "dev.gotcha.co.il")).toEqual([]);
    });

    it("puts every URL on the application host", () => {
      const hosts = [...new Set(urls.map((u) => new URL(u).host))];
      expect(hosts).toEqual(["app.gotcha.co.il"]);
    });

    it("declares the OAuth callback, four webhooks and the app proxy", () => {
      for (const suffix of [
        "/api/connectors/shopify-chat/oauth/callback",
        "/api/shopify-chat/webhooks/app-uninstalled",
        "/api/shopify-chat/webhooks/customers-data-request",
        "/api/shopify-chat/webhooks/customers-redact",
        "/api/shopify-chat/webhooks/shop-redact",
        "/api/shopify-chat/proxy",
      ]) {
        expect(toml, `missing ${suffix}`).toContain(`${APP}${suffix}`);
      }
    });
  });

  // ── The storefront widget ships inside the theme extension ─────────
  describe("Shopify Chat theme extension", () => {
    const rel = "shopify-app/extensions/gotcha-chat/blocks/gotcha_chat.liquid";
    const liquid = read(rel);
    const defaults = [...liquid.matchAll(/default:\s*'(https:\/\/[^']+)'/g)].map((m) => m[1]);

    it("finds the api_base, asset_base and script-src defaults", () => {
      expect(defaults.length).toBeGreaterThanOrEqual(3);
    });

    it("serves the widget from the application host, never the apex", () => {
      expect([...new Set(defaults)]).toEqual([APP]);
    });
  });

  // ── Compose defaults are what a deploy inherits when .env is thin ──
  describe("docker-compose.prod.yml", () => {
    const compose = read("docker-compose.prod.yml");

    it("defaults the Shopify Chat surface to the application host", () => {
      expect(compose).toContain(`SHOPIFY_CHAT_APP_URL: \${SHOPIFY_CHAT_APP_URL:-${APP}}`);
      expect(compose).toContain(
        `SHOPIFY_CHAT_REDIRECT_URI: \${SHOPIFY_CHAT_REDIRECT_URI:-${APP}/api/connectors/shopify-chat/oauth/callback}`,
      );
    });

    it("carries no default pointing at the marketing apex or at Dev", () => {
      const bad = [...compose.matchAll(/:-\s*(https?:\/\/[^}\s]+)}/g)]
        .map((m) => m[1])
        .filter((u) => /(^https?:\/\/gotcha\.co\.il)|dev\.gotcha\.co\.il/.test(u));
      expect(bad).toEqual([]);
    });

    it("requires a Voice origin for both services that talk to Twilio", () => {
      // voice-copilot builds the TwiML; conversation writes the number config.
      const required = compose.match(/VOICE_PUBLIC_URL: \$\{VOICE_PUBLIC_URL:\?required\}/g) ?? [];
      expect(required.length).toBe(2);
    });

    it("requires an application origin", () => {
      expect(compose).toMatch(/APP_ORIGIN: \$\{APP_ORIGIN:\?/);
    });
  });

  // ── nginx is the only thing that decides what a hostname serves ────
  describe("gateway/nginx.prod.conf.template", () => {
    const conf = read("gateway/nginx.prod.conf.template");

    it("gives Voice its own server block", () => {
      expect(conf).toMatch(/server_name\s+voice\.gotcha\.co\.il;/);
    });

    it("serves the media-stream WebSocket and the two Twilio prefixes there", () => {
      const block = conf.slice(conf.indexOf("server_name voice.gotcha.co.il;"));
      const end = block.indexOf("server_name auth.gotcha.co.il;");
      const voiceBlock = end > 0 ? block.slice(0, end) : block;
      expect(voiceBlock).toContain("location /twilio/media-stream");
      expect(voiceBlock).toContain("location /api/voice/incoming");
      expect(voiceBlock).toContain("location /api/voice-copilot");
      expect(voiceBlock, "media stream needs an Upgrade header").toContain("proxy_set_header Upgrade $http_upgrade");
    });

    it("keeps Authentik and the Help Center on their own hostnames", () => {
      expect(conf).toMatch(new RegExp(`server_name\\s+${AUTH_HOST.replace(/\./g, "\\.")};`));
      expect(conf).toMatch(new RegExp(`server_name\\s+${HELP_HOST.replace(/\./g, "\\.")};`));
    });

    it("names the application host explicitly", () => {
      expect(conf).toMatch(/server_name\s+app\.gotcha\.co\.il/);
    });
  });

  // ── Code-level defaults that ship inside an image ──────────────────
  describe("frontend build-time defaults", () => {
    it("shows operators the Voice host for the Twilio webhook", () => {
      const page = read("frontend/src/app/settings/voice-channels/[id]/page.tsx");
      expect(page).toContain(VOICE);
      expect(page).not.toContain("https://gotcha.co.il/api/voice");
    });

    it("sends Help Center sign-in to the application host, not to Dev", () => {
      const kit = read("frontend/src/app/help/HelpKit.tsx");
      expect(kit).not.toContain("dev.gotcha.co.il");
      expect(kit).toContain(APP);
    });
  });

  // ── The identity gate must refuse the hosts that have bitten us ────
  describe("scripts/shopify/verify-chat-app-identity.mjs", () => {
    const src = read("scripts/shopify/verify-chat-app-identity.mjs");

    it("requires the application host in production", () => {
      expect(src).toContain('const PROD_HOST = "app.gotcha.co.il"');
    });

    it("rejects the marketing apex and Dev for a production manifest", () => {
      expect(src).toContain('host === "gotcha.co.il"');
      expect(src).toContain("host === DEV_HOST");
    });
  });

  // ── Nothing production-facing may hardcode a Dev host ──────────────
  it("no production artefact references dev.gotcha.co.il", () => {
    const artefacts = [
      "docker-compose.prod.yml",
      "gateway/nginx.prod.conf.template",
      "shopify-app/shopify.app.toml",
    ].filter(exists);
    for (const rel of artefacts) {
      expect(read(rel), `${rel} references a Dev host`).not.toContain("dev.gotcha.co.il");
    }
  });
});

// ─── The resolvers themselves ───────────────────────────────────────
describe("resolveAppPublicUrl", () => {
  it("returns the configured origin", () => {
    expect(resolveAppPublicUrl({ FRONTEND_URL: APP } as any)).toBe(APP);
  });

  it("refuses to guess in production", () => {
    expect(() => resolveAppPublicUrl({ NODE_ENV: "production" } as any)).toThrow(AppOriginError);
  });

  it("refuses http in production", () => {
    expect(() =>
      resolveAppPublicUrl({ NODE_ENV: "production", FRONTEND_URL: "http://app.gotcha.co.il" } as any),
    ).toThrow(/app_prod_requires_https/);
  });

  it("falls back to localhost only outside production", () => {
    expect(resolveAppPublicUrl({} as any)).toBe("http://localhost:3000");
  });
});

describe("resolveVoicePublicUrl", () => {
  it("returns the Voice origin, not the application origin", () => {
    const env = { NODE_ENV: "production", PUBLIC_BASE_URL: APP, VOICE_PUBLIC_URL: VOICE } as any;
    expect(resolveVoicePublicUrl(env)).toBe(VOICE);
  });

  it("never derives Voice from the application origin in production", () => {
    // The regression this whole separation exists to prevent: PUBLIC_BASE_URL
    // is set, VOICE_PUBLIC_URL is not, and Twilio silently gets the app host.
    expect(() =>
      resolveVoicePublicUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: APP } as any),
    ).toThrow(/voice_public_url_required_in_production/);
  });

  it("refuses http in production - Twilio will not open a wss:// stream", () => {
    expect(() =>
      resolveVoicePublicUrl({ NODE_ENV: "production", VOICE_PUBLIC_URL: "http://voice.gotcha.co.il" } as any),
    ).toThrow(/voice_prod_requires_https/);
  });

  it("falls back to the app origin only outside production", () => {
    expect(resolveVoicePublicUrl({ PUBLIC_BASE_URL: "http://localhost" } as any)).toBe("http://localhost");
  });
});
