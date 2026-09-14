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

  /**
   * The services emit their own Access-Control-Allow-Origin from APP_ORIGIN.
   * Adding ours on top produced TWO headers, and a browser rejects a response
   * carrying more than one - a stricter failure than sending none, and one that
   * looks identical to the original bug from the console.
   */
  it("sends exactly one Access-Control-Allow-Origin by hiding the upstream's", () => {
    for (const route of ["/api/public/pricing", "/api/waitlist"]) {
      const loc = new RegExp(`location\\s+${route.replace(/\//g, "\\/")}\\s*\\{[\\s\\S]*?\\n\\s{8}\\}`);
      const body = loc.exec(CONF)?.[0] ?? "";
      expect(body, `${route} must hide the upstream CORS header before adding its own`)
        .toContain("proxy_hide_header Access-Control-Allow-Origin;");
    }
  });

  /**
   * The landing page embeds the chat widget, which builds its URLs from
   * window.location.origin. On the marketing host that means same-origin
   * /widget/... and /api/embedded-chat/... requests - which the catch-all
   * redirect turned into cross-origin 301s the browser refused. The widget
   * silently stopped loading on the marketing site.
   */
  it("serves the embedded widget on the marketing host rather than redirecting it", () => {
    const mkt = find("gotcha.co.il")!;
    expect(mkt.body, "a cross-origin 301 breaks the widget's own fetches")
      .toMatch(/location\s+\/widget\//);
    expect(mkt.body).toMatch(/location\s+\/api\/embedded-chat/);
  });
});

/**
 * voice.gotcha.co.il is served by the Cloudflare Tunnel going STRAIGHT to
 * voice-copilot, not through the gateway. That is deliberate: a Twilio media
 * stream is a long-lived WebSocket carrying real-time audio, and an extra nginx
 * hop costs latency on every frame.
 *
 * cloudflared runs as a systemd unit on the host, outside this compose network,
 * so `http://localhost:4007` can only reach the container through a PUBLISHED
 * port. There was none - the container merely exposed 4007, the host listened
 * on 80 and nothing else - so every voice request 502'd.
 */
describe("voice direct ingress", () => {
  const COMPOSE_FILE = fs.readFileSync(path.join(ROOT, "docker-compose.prod.yml"), "utf8");
  const block = /\n {2}voice-copilot:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n)/.exec(COMPOSE_FILE)?.[1] ?? "";

  it("publishes the voice port so the tunnel can reach it", () => {
    expect(block, "cloudflared cannot reach an unpublished port").toMatch(/ports:/);
    expect(block).toMatch(/:\$\{VOICE_COPILOT_PORT:-4007\}"?\s*$|:\$\{VOICE_COPILOT_PORT:-4007\}"/m);
  });

  /**
   * The bind address is the whole security argument. 0.0.0.0 would put the
   * voice service on the public internet with only the security group in front.
   */
  it("binds it to the host loopback and not the wildcard", () => {
    const ports = /ports:\n((?:\s+-\s+.*\n)+)/.exec(block)?.[1] ?? "";
    expect(ports).toMatch(/127\.0\.0\.1:/);
    expect(ports, "0.0.0.0 would expose voice-copilot publicly").not.toMatch(/"\s*0\.0\.0\.0:/);
    expect(ports, "a bare host:container mapping binds all interfaces").not.toMatch(/-\s+"\d+:\d+"/);
  });
});

/**
 * try_files is meaningless without a root.
 *
 * nginx falls back to its COMPILE-TIME default root when no directive is in
 * scope. In nginx:alpine that is /etc/nginx/html, which the image does not
 * contain - so every path resolves against nothing. The help vhost declared no
 * root, and there is none at http scope, so help.gotcha.co.il answered:
 *
 *   /            404   (its `location = /` hit the explicit =404)
 *   /index.html  500   (try_files fallback could not be found either)
 *
 * It never served a page in production. The failure is silent in review because
 * the block reads correctly on its own - the missing piece is the absence of a
 * line, in a file where two other vhosts happen to declare it.
 */
describe("static vhosts declare a document root", () => {
  const CONF_TEXT = fs.readFileSync(path.join(ROOT, "gateway/nginx.prod.conf.template"), "utf8");
  const hasHttpScopeRoot = /^ {4}root\s+\S+;/m.test(CONF_TEXT);

  it("every server block serving files from disk sets root", () => {
    const missing = serverBlocks()
      .filter((b) => /try_files/.test(b.body))
      .filter((b) => !/^\s+root\s+\S+;/m.test(b.body))
      .map((b) => b.names[0]);
    expect(
      missing,
      hasHttpScopeRoot
        ? "these rely on an http-scope root"
        : "there is no http-scope root, so these resolve against nginx's compile-time default and serve nothing",
    ).toEqual([]);
  });
});

/**
 * A CORS-enabled location must not let the upstream's own header through.
 *
 * services/ai mounts cors({origin: FRONTEND_URL, credentials: true}) for the
 * dashboard, so an embedded-chat response arrived at nginx already carrying
 * Access-Control-Allow-Origin: https://app.gotcha.co.il. nginx then added its
 * wildcard on top, and a browser refuses a response whose
 * Access-Control-Allow-Origin "contains multiple values" - so the widget was
 * blocked on every site that embedded it, including our own landing page,
 * while curl reported a perfectly healthy 200.
 */
describe("public widget CORS is emitted exactly once", () => {
  const TEMPLATES = ["gateway/nginx.prod.conf.template", "nginx/nginx.conf.template"];

  /** The `location <path> {` block bodies in a template, by brace depth. */
  function locationBlocks(conf: string, pathMatch: RegExp): string[] {
    const out: string[] = [];
    const lines = conf.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*location\s/.test(lines[i]) || !pathMatch.test(lines[i])) continue;
      let depth = 0, body = "";
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) ?? []).length;
        depth -= (lines[j].match(/\}/g) ?? []).length;
        body += lines[j] + "\n";
        if (depth === 0) break;
      }
      out.push(body);
    }
    return out;
  }

  for (const rel of TEMPLATES) {
    it(`${rel}: every location that adds a wildcard origin hides the upstream one`, () => {
      const conf = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const offenders = locationBlocks(conf, /./)
        .filter((b) => /add_header\s+Access-Control-Allow-Origin\s+\*/.test(b))
        .filter((b) => /proxy_pass/.test(b))
        .filter((b) => !/proxy_hide_header\s+Access-Control-Allow-Origin;/.test(b));
      expect(
        offenders.map((b) => (/^\s*location\s+(\S+)/.exec(b) ?? [])[1]),
        "a proxied location that adds its own CORS origin must hide the upstream's, or the browser sees two",
      ).toEqual([]);
    });
  }
});

/**
 * Each public section has ONE address.
 *
 * The Help Center and the Trust Center are sections of the marketing build, and
 * the apex served them as well as their own hostnames did - so every article
 * and every legal document had two working URLs, and the one people reached by
 * clicking through the site was gotcha.co.il/help rather than
 * help.gotcha.co.il. The reverse held too: the marketing header and footer wrap
 * the help articles, and their links resolved against the help host, where
 * `location /` maps an unprefixed path onto /help$uri - so /about quietly
 * rendered the help index instead of the About page.
 */
describe("section hostnames own their sections", () => {
  const mkt = () => find("gotcha.co.il")!;
  const help = () => find("help.gotcha.co.il")!;
  const trust = () => find("trust.gotcha.co.il")!;

  it("sends /help from the apex to the Help Center, without the prefix", () => {
    expect(mkt().body).toMatch(
      /rewrite\s+\^\/help\/\?\(\.\*\)\$\s+https:\/\/help\.gotcha\.co\.il\/\$1\s+redirect/,
    );
  });

  it("does not also serve those two sections from the apex allowlist", () => {
    const allow = /location\s+~\s+\^\/\(([^)]+)\)\(\/\|\$\)/.exec(mkt().body);
    expect(allow, "the marketing allowlist must still exist").not.toBeNull();
    const routes = allow![1].split("|");
    expect(routes, "help has its own hostname").not.toContain("help");
    expect(routes, "legal has its own hostname").not.toContain("legal");
  });

  it("keeps serving the legal documents until the Trust Center has DNS", () => {
    // An unresolvable redirect would take them offline, so the redirect is
    // guarded and the try_files that serves them stays underneath it.
    const legal = /location\s+\^~\s+\/legal\s*\{([\s\S]*?)\n {8}\}/.exec(mkt().body);
    expect(legal, "the apex must handle /legal explicitly").not.toBeNull();
    expect(legal![1]).toMatch(/if\s+\(\$trust_public_url\s*!=\s*""\)/);
    expect(legal![1], "the documents must still be served when it is unset").toMatch(/try_files/);
    expect(CONF, "the host must come from the environment").toMatch(
      /map\s+\$host\s+\$trust_public_url\s*\{[\s\S]*?\$\{TRUST_PUBLIC_URL\}/,
    );
  });

  it("passes TRUST_PUBLIC_URL through envsubst", () => {
    // Same trap as PUBLIC_PRICING_ENABLED: a variable the allowlist omits is
    // left as the literal ${NAME}, which is never empty - so the guard above
    // would read as "set" and redirect at a hostname that does not resolve.
    const dockerfile = fs.readFileSync(path.join(ROOT, "gateway/Dockerfile.prod"), "utf8");
    expect(dockerfile).toContain("$TRUST_PUBLIC_URL");
  });

  it("sends the shared chrome's links from the section hosts back to the apex", () => {
    for (const [name, block] of [["help", help()], ["trust", trust()]] as const) {
      expect(block.body, `${name} must return marketing paths to the apex`).toMatch(
        /location\s+~\s+\^\/\([^)]*about[^)]*\)\(\/\|\$\)\s*\{\s*\n\s*return\s+302\s+https:\/\/gotcha\.co\.il\$request_uri/,
      );
    }
  });

  it("keeps /privacy-policy on the Trust Center, where it is a document", () => {
    // It is a marketing route on the apex and a legal slug here. Sending it
    // away would make the Trust Center's most-read page the one it cannot serve.
    const away = /location\s+~\s+\^\/\(([^)]+)\)\(\/\|\$\)\s*\{\s*\n\s*return\s+302/.exec(trust().body);
    expect(away).not.toBeNull();
    expect(away![1].split("|")).not.toContain("privacy-policy");
  });
});

/**
 * The typefaces the design is drawn in must be allowed to load.
 *
 * style-src was 'self' 'unsafe-inline', which blocked the Google Fonts
 * stylesheets every page links - so Archivo, Instrument Serif, IBM Plex Mono
 * and Heebo were all refused and the site fell back to a system font. Nothing
 * failed server-side; it showed only as the wrong typography and a console
 * message.
 */
describe("content security policy allows what the pages actually load", () => {
  const policies = CONF.match(/add_header\s+Content-Security-Policy\s+"[^"]+"/g) ?? [];

  it("finds the policies", () => {
    expect(policies.length).toBeGreaterThan(10);
  });

  it("allows the Google Fonts stylesheet wherever a style-src is declared", () => {
    const offenders = policies.filter(
      (p) => /style-src/.test(p) && !/style-src[^;]*fonts\.googleapis\.com/.test(p),
    );
    expect(offenders, "a style-src that omits it blocks the design's typefaces").toEqual([]);
  });

  it("allows Cloudflare's analytics beacon wherever scripts are allowed at all", () => {
    // Cloudflare injects it at the edge on every proxied response, so a
    // script-src that omits it logs a violation on every single page view.
    const offenders = policies.filter(
      (p) => /script-src\s+'self'/.test(p) && !/script-src[^;]*static\.cloudflareinsights\.com/.test(p),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * A section host must serve the files its pages ask for.
 *
 * Both section vhosts end in a catch-all that maps an unprefixed path onto
 * their own section - /x becomes /help/x - which is right for a page and wrong
 * for an asset: a missing asset does not 404, it comes back as the section
 * index. /assets/favicon.svg on help.gotcha.co.il returned 43KB of HTML where
 * the browser asked for an icon, so the Help Center had no tab icon and
 * nothing in any log said so.
 */
describe("section hosts serve their assets before the catch-all", () => {
  for (const name of ["help.gotcha.co.il", "trust.gotcha.co.il"]) {
    it(`${name}: passes /assets/ through untouched`, () => {
      // The location line of every block whose body is a bare pass-through.
      const passthrough = [...find(name)!.body.matchAll(
        /^(\s*location\s+[^\n{]+)\{\s*\n\s*try_files\s+\$uri\s+=404;\s*\n\s*\}/gm,
      )].map((m) => m[1]);
      expect(passthrough.length, `${name} must serve some files as-is`).toBeGreaterThan(0);
      expect(
        passthrough.join('\n'),
        "the marketing build puts every referenced file under assets/, tab icons included",
      ).toMatch(/assets/);
    });
  }
});

/**
 * Hebrew is an address, and a missing page is a 404.
 *
 * The design keeps both languages in one bundle and switches them from the
 * footer, so the site was one URL that happened to load in English: a link to
 * the offer page opened in English for whoever received it. Every page now has
 * a second path under /he, prerendered, so a link opens in the language it was
 * sent in.
 *
 * The second half of this is the reason it looked impossible. `try_files`'
 * last argument is an internal REDIRECT, so a `/404.html` fallback re-entered
 * location matching, hit the catch-all and 301'd to app.gotcha.co.il with the
 * original path - where the OLD landing still answers at /he. So
 * gotcha.co.il/he did not 404, it silently handed the visitor a different
 * design on another hostname, and every other missing page did too.
 */
describe("the landing answers in both languages", () => {
  const marketing = () => find("gotcha.co.il")!.body;

  it("serves /he from the marketing host", () => {
    const allow = /location\s+~\s+\^\/\(([^)]+)\)\(\/\|\$\)/.exec(marketing());
    expect(allow, "the marketing allowlist must exist").not.toBeNull();
    expect(allow![1].split("|"), "Hebrew is served here, not redirected away").toContain("he");
  });

  it("prerenders every page in Hebrew as well as English", () => {
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
    const pages = read("landing/src/lib/pages.ts");
    expect(pages, "both halves come from one list").toContain("ALL_LOCALISED_PATHS");
    const route = read("landing/src/app/[[...slug]]/page.tsx");
    expect(route, "the route generates both").toContain("ALL_LOCALISED_PATHS");
    expect(route, "and the language is server-rendered, not toggled after arrival")
      .toMatch(/initialLang=\{?\s*found\.lang/);
  });

  it("keeps a missing page on this host instead of handing it to the application", () => {
    // `=404`, not a file: try_files' last argument is an internal redirect, and
    // a filename there re-enters location matching and reaches the catch-all.
    const block = /location\s+~\s+\^\/\([^)]+\)\(\/\|\$\)\s*\{([\s\S]*?)\n        \}/.exec(marketing());
    expect(block, "the allowlist block must exist").not.toBeNull();
    expect(block![1], "a fallback FILE leaks to app.gotcha.co.il").toMatch(/try_files[^\n]*=404;/);
    expect(block![1], "and a leaked 404 must not be reintroduced as a path")
      .not.toMatch(/try_files[^\n]*\/404\.html/);
    expect(marketing(), "the 404 page is served by error_page instead").toMatch(/error_page\s+404\s+\/404\.html;/);
  });

  it("normalises a trailing slash rather than losing the page", () => {
    // The export writes /he/offer.html, so /he/offer/ matched nothing and fell
    // through to the redirect. People type and paste the slash.
    expect(marketing()).toMatch(/rewrite\s+\^\(\/\.\+\)\/\$\s+\$1\s+permanent;/);
  });

  it("folds /en onto the page it names", () => {
    // English is what the bare path already is. /en existed on the old landing
    // and links to it are out there, so they are folded rather than 404'd.
    expect(marketing()).toMatch(/rewrite\s+\^\/en\/\?\(\.\*\)\$\s+\/\$1\s+permanent;/);
  });

  it("retires the old landing still shipped by the application build", () => {
    // frontend/src/app/{he,en}/page.tsx render the previous design, and their
    // own metadata declares gotcha.co.il/he as canonical - which is now a
    // different page. Two designs answering to one name.
    const app = find("app.gotcha.co.il")!.body;
    expect(app).toMatch(/location\s+~\s+\^\/\(he\|en\)\(\/\|\$\)\s*\{\s*\n\s*return\s+301\s+https:\/\/gotcha\.co\.il\$request_uri/);
  });
});

/**
 * The pixel is opt-in, and the documents that promise that stay true.
 *
 * A tracker that loads and is then told to stay quiet is not consent: the
 * request has already been made and the other company has already seen it. So
 * the script is injected when the switch turns on, and not before.
 *
 * The Cookie Policy is published at trust.gotcha.co.il in two languages and
 * said, in as many words, that there were no social media pixels. Installing
 * one without changing that leaves a signed document contradicting the site.
 */
describe("the Meta pixel is opt-in", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const pixel = () => read("landing/src/components/MetaPixel.tsx");
  const consent = () => read("landing/src/lib/consent.ts");

  it("loads nothing until the marketing switch is on", () => {
    const src = pixel();
    expect(src, "the script is injected from the consent branch")
      .toMatch(/if\s*\(!allowed\)\s*return;/);
    expect(src, "and there is no other way in").not.toMatch(/fbevents\.js[\s\S]{0,200}dangerouslySetInnerHTML/);
    // `fbq('consent', 'revoke')` would still download the script and still show
    // Meta the request. Gating the injection is the only refusal that refuses.
    // Comments are stripped first: the file explains why that call is absent,
    // and prose about a thing is not the thing.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/consent['"]\s*,\s*['"]revoke/);
  });

  it("asks for marketing separately from analytics", () => {
    // Counting page views and letting an ad network recognise you are not the
    // same question, and one yes must not be read as the other.
    expect(consent()).toMatch(/marketing:\s*boolean/);
    expect(consent(), "both are written, so neither is inferred")
      .toMatch(/writeConsent\(analytics:\s*boolean,\s*marketing:\s*boolean\)/);
    const card = read("landing/src/components/CookieNotice.tsx");
    expect(card, "two switches, not one").toMatch(/setMarketing/);
    expect(card).toMatch(/decide\(analytics,\s*marketing\)/);
  });

  it("invalidates decisions taken before the category existed", () => {
    // A yes to two questions is not a yes to three.
    expect(consent()).toMatch(/CONSENT_VERSION\s*=\s*2/);
    expect(consent(), "a record missing the field defaults to no, not to itself")
      .toMatch(/marketing:\s*parsed\.marketing === true/);
  });

  it("keeps one consent record, so a yes takes effect where it is given", () => {
    // The card and the pixel both call useConsent. While each held its own
    // useState the card could record a yes the pixel never heard, and the
    // pixel only noticed on the next page load.
    expect(consent()).toMatch(/const listeners = new Set/);
    expect(consent()).toMatch(/listeners\.forEach/);
  });

  it("reports each navigation, because the landing moves by pushState", () => {
    const src = pixel();
    expect(src, "pushState fires no event of its own").toMatch(/pushState/);
    expect(src).toMatch(/popstate/);
    expect(src, "and the same address twice is one view").toMatch(/reported\.current/);
  });

  it("is allowed by the marketing host's CSP", () => {
    // Everything else on this site that was quietly blocked - the design's
    // typefaces, Cloudflare's beacon - was blocked exactly this way.
    const mkt = find("gotcha.co.il")!.body;
    const policy = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(mkt);
    expect(policy, "the marketing host must declare a policy").not.toBeNull();
    expect(policy![1], "the pixel script would be refused without it")
      .toMatch(/script-src[^;]*connect\.facebook\.net/);
  });

  it("is named in the Cookie Policy, in both languages", () => {
    for (const lang of ["en", "he"]) {
      const doc = read(`docs/legal/${lang}/cookie-policy.md`);
      expect(doc, `${lang}: the pixel must be disclosed`).toMatch(/Meta/);
      expect(doc, `${lang}: the old "no pixels" claim must be gone`)
        .not.toMatch(/no social media pixels|אין פיקסלים של רשתות חברתיות/);
    }
  });
});
