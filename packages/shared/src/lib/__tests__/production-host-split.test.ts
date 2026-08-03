/**
 * gotcha.co.il and app.gotcha.co.il must not be the same website.
 *
 * The prod gateway declared `server_name app.gotcha.co.il _;` and nothing else,
 * so the `_` catch-all swallowed the marketing apex: both hostnames returned
 * byte-identical responses. Two consequences, neither visible from dev, where
 * only one hostname exists:
 *
 *   1. The marketing landing page rendered on the application host.
 *   2. Every application route was reachable on the marketing domain, so search
 *      engines could index a duplicate of every page under two hostnames.
 *
 * And a third that surfaced as a user-visible error: the bundle bakes
 * NEXT_PUBLIC_API_URL as https://app.gotcha.co.il, so the identical pricing page
 * served from gotcha.co.il made a cross-origin call that no CORS header allowed.
 * It rendered "We could not load pricing" while app.gotcha.co.il worked.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
const CONF = fs.readFileSync(path.join(ROOT, "gateway/nginx.prod.conf.template"), "utf8");

/** Split the file into server blocks by brace depth. */
function serverBlocks(): { names: string[]; body: string }[] {
  const out: { names: string[]; body: string }[] = [];
  const lines = CONF.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*server\s*\{/.test(lines[i])) continue;
    let depth = 0, body = "";
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) ?? []).length;
      depth -= (lines[j].match(/\}/g) ?? []).length;
      body += lines[j] + "\n";
      if (depth === 0) break;
    }
    const m = /server_name\s+([^;]+);/.exec(body);
    // `upstream` blocks also contain `server` lines; a real vhost has a name.
    if (m) out.push({ names: m[1].trim().split(/\s+/), body });
  }
  return out;
}

const blocks = serverBlocks();
const find = (name: string) => blocks.find((b) => b.names.includes(name));

describe("production hostname split", () => {
  it("gives the marketing apex its own vhost", () => {
    expect(find("gotcha.co.il"), "gotcha.co.il must not fall through to the app catch-all").toBeDefined();
  });

  it("keeps the application host as the default server", () => {
    const app = find("app.gotcha.co.il");
    expect(app).toBeDefined();
    expect(app!.names, "an unnamed host must still reach the app, not nginx's error path").toContain("_");
  });

  /**
   * The catch-all must live on the application vhost and nowhere else. A `_` on
   * the marketing block would re-absorb every hostname and silently undo the
   * split without changing any other line.
   */
  it("declares the catch-all exactly once", () => {
    const withCatchAll = blocks.filter((b) => b.names.includes("_")).map((b) => b.names[0]);
    expect(withCatchAll).toEqual(["app.gotcha.co.il"]);
  });

  it("redirects application routes off the marketing host", () => {
    const mkt = find("gotcha.co.il")!;
    expect(mkt.body, "the marketing fallback must send app routes to the app host")
      .toMatch(/location\s+\/\s*\{[^}]*return\s+301\s+https:\/\/app\.gotcha\.co\.il\$request_uri/);
  });

  /**
   * The public surface is an allowlist, not a denylist: an application route
   * added later must be private on the marketing host by default rather than
   * appearing there because nobody remembered to exclude it.
   */
  it("serves the public pages from the marketing host", () => {
    const mkt = find("gotcha.co.il")!;
    for (const route of ["early-access", "legal", "privacy-policy", "terms", "pricing"]) {
      expect(mkt.body, `${route} must be served on the marketing host`).toContain(route);
    }
  });

  it("serves build assets from the marketing host", () => {
    const mkt = find("gotcha.co.il")!;
    // Without these the redirect swallows every chunk and the pages render blank.
    expect(mkt.body).toMatch(/location\s+\^~\s+\/_next\//);
  });

  it("makes www a redirect rather than a second marketing host", () => {
    const www = find("www.gotcha.co.il");
    expect(www, "www must be handled explicitly").toBeDefined();
    expect(www!.body).toMatch(/return\s+301\s+https:\/\/gotcha\.co\.il\$request_uri/);
    expect(www!.names, "www must not also serve marketing").not.toContain("gotcha.co.il");
  });

  it("honours the pricing kill switch on the marketing host too", () => {
    const mkt = find("gotcha.co.il")!;
    expect(mkt.body, "a disabled flag must not be bypassable by asking the other hostname")
      .toMatch(/public_pricing_enabled\s*!=\s*"true"/);
  });
});

describe("public API cross-origin access", () => {
  const map = /map\s+\$http_origin\s+\$public_api_cors_origin\s*\{([^}]*)\}/.exec(CONF);

  it("defines an origin allowlist for the unauthenticated API", () => {
    expect(map, "the marketing host cannot read the public API without one").not.toBeNull();
  });

  it("allows the marketing origin and denies everything unlisted", () => {
    expect(map![1]).toMatch(/gotcha\\?\.co\\?\.il/);
    // An unmatched origin must yield "", which nginx renders as no header at
    // all. A "*" default would expose every future /api/public/* route.
    expect(map![1], "unknown origins must get no CORS header").toMatch(/default\s+"";/);
    expect(map![1]).not.toMatch(/default\s+["']?\*/);
  });

  it("sends the header on the routes the marketing pages call", () => {
    for (const route of ["/api/public/pricing", "/api/waitlist"]) {
      const loc = new RegExp(`location\\s+${route.replace(/\//g, "\\/")}\\s*\\{[\\s\\S]*?\\n\\s{8}\\}`);
      const body = loc.exec(CONF)?.[0] ?? "";
      expect(body, `${route} must echo the allowed origin`)
        .toContain("add_header Access-Control-Allow-Origin $public_api_cors_origin always;");
      expect(body, `${route} must vary on Origin so a cached response is not reused cross-host`)
        .toContain('add_header Vary "Origin" always;');
    }
  });

  /**
   * The early-access form posts JSON, which is not a simple content type, so
   * the browser preflights. nginx has to answer: the service never sees OPTIONS.
   */
  it("answers the waitlist preflight", () => {
    const loc = /location\s+\/api\/waitlist\s*\{[\s\S]*?\n\s{8}\}/.exec(CONF)?.[0] ?? "";
    expect(loc).toMatch(/if\s+\(\$request_method\s*=\s*OPTIONS\)/);
    expect(loc).toMatch(/return\s+204/);
    expect(loc).toContain("Access-Control-Allow-Headers");
  });
});
