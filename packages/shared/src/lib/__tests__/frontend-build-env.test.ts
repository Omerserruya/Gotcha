/**
 * Every NEXT_PUBLIC_* the frontend reads must be baked by the publisher.
 *
 * `NEXT_PUBLIC_*` is frozen into the static bundle at build time. In production
 * the bundle is baked into the gateway image, so a variable the publisher never
 * exports is not "unset until someone fixes .env" - it is `undefined` forever,
 * and no amount of editing .env on the box changes it.
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

/** Every NEXT_PUBLIC_* the frontend source actually reads. */
function readByFrontend(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || p.includes("__tests__")) continue;
      for (const m of fs.readFileSync(p, "utf8").matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
        found.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, "frontend/src"));
  return found;
}

/** Every NEXT_PUBLIC_* docker-publish.sh exports into the build. */
function bakedByPublisher(): Set<string> {
  const script = fs.readFileSync(path.join(ROOT, "scripts/docker-publish.sh"), "utf8");
  return new Set([...script.matchAll(/(NEXT_PUBLIC_[A-Z0-9_]+)="/g)].map((m) => m[1]));
}

describe("frontend build-time environment", () => {
  it("finds the variables the frontend reads", () => {
    expect(readByFrontend().size).toBeGreaterThan(5);
  });

  it("bakes every NEXT_PUBLIC_* the frontend reads", () => {
    const baked = bakedByPublisher();
    const missing = [...readByFrontend()].filter((v) => !baked.has(v)).sort();
    expect(
      missing,
      "these resolve to undefined in the production bundle, permanently and silently",
    ).toEqual([]);
  });
});
