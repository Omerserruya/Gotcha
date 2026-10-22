/**
 * Every NEXT_PUBLIC_* the frontend reads must be baked by the publisher.
 *
 * `NEXT_PUBLIC_*` is frozen into the bundle at build time. In production the
 * bundle is baked into the app's image, so a variable the publisher never
 * passes is not "unset until someone fixes .env" - it is `undefined` forever,
 * and no amount of editing .env on the box changes it. (The examples below are
 * from the legacy frontend, which hit exactly this; the rule is the same.)
 *
 * That failure is silent by construction, because the code that reads these has
 * to tolerate absence:
 *
 *   NEXT_PUBLIC_PRICING_ENABLED  fell back to "false", so the pricing section
 *                                simply did not render and looked like a
 *                                deliberate product decision.
 *   NEXT_PUBLIC_SOCIAL_*         an unset social URL renders no icon at all,
 *                                so the footer just looked sparse.
 *
 * Nothing errors, nothing logs, and the flag in .env.prod says the opposite of
 * what the user sees - which sends you looking at nginx and the database before
 * you think to look at the build.
 *
 * The pricing flag additionally has a SECOND gate in nginx, and only the bundle
 * half needs a rebuild. Fixing one and not the other produces a route that
 * works and a nav that hides it.
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

/**
 * Strip comments before scanning.
 *
 * Next.js inlines a NEXT_PUBLIC_* only where the literal expression appears in
 * CODE, so a mention inside a comment is not a read - and treating it as one
 * fails this guard for a variable that does not exist. That is not theoretical:
 * `frontend/src/lib/sentry-client.ts` documents the inlining rule by quoting
 * `process.env.NEXT_PUBLIC_FOO` as an example, and this scanner counted the
 * example, demanding that docker-publish.sh bake a variable named FOO.
 *
 * The `//` case guards against `:` so a `https://` inside a string literal does
 * not swallow the rest of its line, which could hide a real read.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every NEXT_PUBLIC_* the frontend source actually reads. */
/**
 * The app (frontend-v2) is the only frontend built since 2026-10-21; the legacy
 * frontend/ is code only. Every NEXT_PUBLIC_* is inlined into the browser
 * bundle at `next build`, so a value the publisher does not pass as a build
 * arg is undefined in production, permanently and silently.
 */
function readByApp(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name) || p.includes("__tests__")) continue;
      const code = stripComments(fs.readFileSync(p, "utf8"));
      for (const m of code.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) found.add(m[1]);
    }
  };
  walk(path.join(ROOT, "frontend-v2/src"));
  return found;
}

const publisher = () => fs.readFileSync(path.join(ROOT, "scripts/docker-publish.sh"), "utf8");

/** `--build-arg "NEXT_PUBLIC_X=` in the publisher, split by whether it is conditional. */
function passedByPublisher(): { always: Set<string>; any: Set<string> } {
  const script = publisher();
  const any = new Set([...script.matchAll(/--build-arg "(NEXT_PUBLIC_[A-Z0-9_]+)=/g)].map((m) => m[1]));
  const always = new Set(
    [...script.matchAll(/^\s+--build-arg "(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );
  return { always, any };
}

/**
 * Read by the app but deliberately not always passed:
 *   FLOW_EXECUTOR_BASE   unset means `/auth-api`, the gateway's proxy; only the
 *                        auth-origin build sets it.
 *   SENTRY_*             optional; an ARG passed empty is SET, and the app's
 *                        schema rejects '', so these are passed only when set.
 */
const OPTIONAL = new Set(["NEXT_PUBLIC_FLOW_EXECUTOR_BASE", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE"]);
const REQUIRED = ["NEXT_PUBLIC_BASE_PATH", "NEXT_PUBLIC_APP_ENV", "NEXT_PUBLIC_REALTIME_URL", "NEXT_PUBLIC_RELEASE"];

describe("the app's build-time environment (frontend-v2)", () => {
  it("finds the variables the app reads", () => {
    expect(readByApp().size).toBeGreaterThan(3);
  });

  it("passes every NEXT_PUBLIC_* the app reads, or lists why not", () => {
    const { any } = passedByPublisher();
    const missing = [...readByApp()].filter((v) => !any.has(v) && !OPTIONAL.has(v)).sort();
    expect(missing, "these resolve to undefined in the production bundle").toEqual([]);
  });

  it("always passes the ones the bundle cannot do without", () => {
    const { always } = passedByPublisher();
    expect(REQUIRED.filter((v) => !always.has(v))).toEqual([]);
    // Root-mounted: the app is the whole site.
    expect(publisher()).toMatch(/--build-arg "NEXT_PUBLIC_BASE_PATH="\n/);
  });

  it("declares an ARG for every value it is passed (an undeclared build arg is ignored)", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "frontend-v2/Dockerfile"), "utf8");
    const declared = new Set([...dockerfile.matchAll(/^ARG (NEXT_PUBLIC_[A-Z0-9_]+)\s*$/gm)].map((m) => m[1]));
    expect([...passedByPublisher().any].filter((v) => !declared.has(v)).sort()).toEqual([]);
  });

  it("never builds the legacy frontend", () => {
    const script = publisher();
    expect(script).not.toMatch(/frontend\/out/);
    expect(script).not.toMatch(/^\s*cd frontend\s*$/m);
    expect(script).toMatch(/push_image frontend-v2 frontend-v2\/Dockerfile frontend-v2/);
  });
});
