/**
 * NEXT_PUBLIC_* must be read as literal `process.env.NEXT_PUBLIC_X` expressions.
 *
 * Next.js substitutes these at BUILD time by matching that exact text. Read
 * through an alias - most naturally a function parameter defaulting to
 * `process.env`, added to make the module testable - there is nothing to match.
 * The expression survives into the bundle, and at runtime in the browser
 * `process.env` is an empty object, so the value is `undefined` forever.
 *
 * This is what shipped: a production gateway built with a real Sentry DSN whose
 * bundle contained no trace of it. The build log printed the DSN as set. The
 * only way it was caught was grepping the built artifact.
 *
 * The failure is silent in every direction - it type-checks, it tests green
 * (tests inject their own env), and it produces a working build. So it gets a
 * test of its own.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..");

/** Every .ts/.tsx file under src/. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "__tests__") walk(f); continue; }
      if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(f);
    }
  };
  walk(SRC);
  return out;
}

describe("NEXT_PUBLIC inlining", () => {
  /**
   * A function that defaults a parameter to `process.env` and then reads a
   * NEXT_PUBLIC_ key off that parameter is the exact shape that breaks. The
   * safe form captures the literals at module scope first.
   */
  it("never reads a NEXT_PUBLIC_ key through a parameter defaulted to process.env", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const src = fs.readFileSync(file, "utf8");
      // A parameter aliasing process.env. Kept to ONE line: a cross-line
      // match swallows unrelated object literals and reports the wrong name,
      // which is how the first version of this guard passed a mutation.
      const aliases = Array.from(src.matchAll(/(\w+)\s*:[^=\n]*=\s*process\.env\b/g)).map((m) => m[1]);
      for (const alias of aliases) {
        // ...that is then used to read a NEXT_PUBLIC_ key.
        if (new RegExp(`\\b${alias}\\.NEXT_PUBLIC_`).test(src)) {
          offenders.push(`${path.relative(SRC, file)} (via \`${alias}\`)`);
        }
      }
    }
    expect(
      offenders.sort(),
      "these read NEXT_PUBLIC_ through an alias, so Next cannot inline them and they are undefined in the browser",
    ).toEqual([]);
  });

  /** The Sentry client specifically, since that is where it bit. */
  it("sentry-client reads its NEXT_PUBLIC values as literal expressions", () => {
    const src = fs.readFileSync(path.join(SRC, "lib", "sentry-client.ts"), "utf8");
    for (const key of ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]) {
      expect(src, `${key} must appear as process.env.${key}`).toContain(`process.env.${key}`);
    }
  });
});
