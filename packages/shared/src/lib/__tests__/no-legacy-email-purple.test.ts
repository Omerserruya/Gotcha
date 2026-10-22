/**
 * No email carries the retired purple accent #7C3291 (2026-10-22).
 *
 * Every product email is built in services/ and packages/ (renderBrandEmail and
 * its callers) and Authentik's reset email lives in scripts/authentik/templates.
 * The old accent leaked into otherwise on-brand emails through hand-written
 * `<strong style="color:#7C3291">` in expiry notes; this scans every source that
 * can produce an email body, so it cannot come back unnoticed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const PURPLE = /#?7C3291/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|html)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const roots = [
  ...fs.readdirSync(path.join(ROOT, "services")).map((s) => path.join(ROOT, "services", s, "src")),
  ...fs.readdirSync(path.join(ROOT, "packages")).map((p) => path.join(ROOT, "packages", p, "src")),
  path.join(ROOT, "scripts/authentik/templates"),
];

describe("★ the retired email purple", () => {
  it("appears in no source that builds an email", () => {
    const files = roots.flatMap((r) => walk(r));
    expect(files.length).toBeGreaterThan(100); // the scan really ran
    const hits = files
      .filter((f) => PURPLE.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
