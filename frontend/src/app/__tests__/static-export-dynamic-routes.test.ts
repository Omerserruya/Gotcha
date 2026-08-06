/**
 * Static-export guard for dynamic route segments.
 *
 * The production frontend is a Next.js static export baked into the gateway
 * image. `output: export` refuses to build a `[param]` segment that cannot
 * enumerate its params, so every dynamic route needs `generateStaticParams`.
 *
 * Two routes were missing it - `settings/business-systems/[provider]` and
 * `system/plans/[id]` - and the failure mode is worth recording, because it is
 * not the one you would guess:
 *
 *   The dev stack runs `next dev`, which does not care. Nothing is wrong
 *   locally, in CI, or in any test. The build only fails when someone
 *   assembles a PRODUCTION gateway image, which happens rarely and usually
 *   under time pressure. Both routes had been on main for some time.
 *
 * There is a second half. Emitting the params is not enough: the export
 * produces a single "_" placeholder directory rather than per-id HTML, so
 * nginx has to map /<base>/<id> onto it. A route with `generateStaticParams`
 * but no nginx rule BUILDS FINE and then serves the root shell on refresh or
 * deep-link, rendering a blank page - which is the bug the nginx comment at
 * that location describes. So both halves are asserted here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(__dirname, "..");
const NGINX = path.resolve(__dirname, "../../../../gateway/nginx.prod.conf.template");

/** Every `[param]` directory under app/, as a route base + param name. */
function dynamicSegments(dir: string, base = ""): Array<{ dir: string; route: string; param: string }> {
  const out: Array<{ dir: string; route: string; param: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Route groups `(name)` do not appear in the URL.
    const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
    const isDynamic = entry.name.startsWith("[") && entry.name.endsWith("]");
    const full = path.join(dir, entry.name);
    const route = isGroup ? base : `${base}/${entry.name}`;
    if (isDynamic) {
      out.push({ dir: full, route: base, param: entry.name.slice(1, -1) });
    }
    out.push(...dynamicSegments(full, route));
  }
  return out;
}

const segments = dynamicSegments(APP_DIR);

function declaresStaticParams(segDir: string): boolean {
  for (const f of ["layout.tsx", "page.tsx", "layout.ts", "page.ts"]) {
    const p = path.join(segDir, f);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("generateStaticParams")) return true;
  }
  return false;
}

describe("static export: dynamic route segments", () => {
  it("finds the dynamic segments", () => {
    expect(segments.length).toBeGreaterThan(10);
  });

  it("every dynamic segment declares generateStaticParams", () => {
    const missing = segments
      .filter((s) => !declaresStaticParams(s.dir))
      .map((s) => `${s.route}/[${s.param}]`)
      .sort();
    expect(missing, "`output: export` cannot build these").toEqual([]);
  });

  it("every placeholder-style segment has an nginx rule mapping it to /_/", () => {
    const conf = fs.readFileSync(NGINX, "utf8");
    // The alternation of route bases nginx maps onto the "_" placeholder.
    const alternations = [...conf.matchAll(/location ~ \^\/\(([^)]+)\)\/\[\^\/\]\+/g)].map((m) => m[1]);
    expect(alternations.length, "expected the placeholder location blocks").toBeGreaterThanOrEqual(2);
    const covered = new Set(alternations.flatMap((a) => a.split("|")));

    // Segments whose generateStaticParams emits the literal "_" placeholder
    // need the rewrite. Routes that enumerate real slugs (help, legal) render
    // per-slug HTML and resolve on their own.
    const placeholderRoutes = segments.filter((s) => {
      for (const f of ["layout.tsx", "page.tsx"]) {
        const p = path.join(s.dir, f);
        if (fs.existsSync(p) && /return\s*\[\s*\{\s*\w+:\s*"_"\s*\}\s*\]/.test(fs.readFileSync(p, "utf8"))) {
          return true;
        }
      }
      return false;
    });

    const unmapped = placeholderRoutes
      .map((s) => s.route.replace(/^\//, ""))
      .filter((base) => !covered.has(base))
      .sort();
    expect(unmapped, "these build, then render a blank page on refresh").toEqual([]);
  });

  /**
   * The half the rule above does not cover, and the half that shipped broken.
   *
   * `[^/]+` cannot cross a slash, so a rule written for /<base>/<id> does not
   * match /<base>/<id>/routing. The export emits that page as
   * /<base>/_/routing/index.html, nginx matched nothing, and the request fell
   * through to /index.html - the root shell. Three pages were unreachable in
   * production this way (voice-channel routing, department copilot, call
   * replay) while building perfectly and passing every test above. The merchant
   * report was "the option is gone from the UI", which is exactly what a page
   * that never mounts looks like.
   */
  it("every SUB-PAGE of a dynamic segment has an nginx rule too", () => {
    const conf = fs.readFileSync(NGINX, "utf8");
    // Locations shaped ^/(bases)/[^/]+/([^/]+) - i.e. id PLUS one more segment.
    const nested = [...conf.matchAll(/location ~ \^\/\(([^)]+)\)\/\[\^\/\]\+\/\(\[\^\/\]\+\)/g)].map((m) => m[1]);
    const coveredNested = new Set(nested.flatMap((a) => a.split("|")));

    /** Child routes of a dynamic segment: `routing`, `copilot`, `replay`… */
    function subPages(segDir: string): string[] {
      return fs
        .readdirSync(segDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("[") && !e.name.startsWith("("))
        .filter((e) =>
          ["page.tsx", "page.ts"].some((f) => fs.existsSync(path.join(segDir, e.name, f))),
        )
        .map((e) => e.name);
    }

    const unmapped: string[] = [];
    for (const seg of segments) {
      const subs = subPages(seg.dir);
      if (!subs.length) continue;
      const base = seg.route.replace(/^\//, "");
      for (const sub of subs) {
        if (!coveredNested.has(base)) unmapped.push(`${base}/[id]/${sub}`);
      }
    }
    expect(unmapped.sort(), "these build, then serve the root shell on refresh or deep-link").toEqual([]);
  });
});
