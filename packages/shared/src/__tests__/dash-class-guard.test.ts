/**
 * No dash-rewriting character class may contain an ASCII hyphen.
 *
 * On 2026-08-05 a repo-wide sweep replaced wide dashes with hyphens in
 * comments and docs. It also landed inside the character classes that
 * DETECT wide dashes, and inverted every one of them:
 *
 *   hasAiSignaturePunctuation   /[—–―]/   ->   /[-–―]/
 *
 * A `-` at the HEAD of a character class is a literal hyphen, so the
 * guard stopped catching the em-dash it exists for and started flagging
 * every ordinary hyphen. The clause scrubber rewrites its matches to
 * ", ", so with a hyphen in the class a phone number "054-123-4567"
 * becomes "054, 123, 4567" in every outgoing customer message.
 *
 * A source-level guard already existed, but it named two files by hand
 * and the sweep broke two others it did not cover. Naming files by hand
 * is how you catch the incident you already had. This walks the tree
 * instead, so the NEXT one is caught too - including in a file nobody has
 * written yet.
 *
 * The durable half of the fix is that every such class is now spelled
 * with \u escapes, which a text find-replace cannot reach. This test is
 * what stops someone helpfully "simplifying" them back into literals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** Source roots that can ship customer-facing text. */
const ROOTS = [
  "packages/shared/src",
  "services/ai/src",
  "services/conversation/src",
  "services/incoming-worker/src",
  "services/outgoing-worker/src",
];

/**
 * Deliberate exceptions, each with a reason.
 *
 * A numeric-range matcher is SUPPOSED to match a hyphen: "156-162" is the
 * common form and the whole point is to normalise all four spellings to
 * one. It is an exception because it MATCHES ranges, never because it
 * rewrites a dash to a comma.
 */
const ALLOWED = [
  { file: "packages/shared/src/lib/customer-text.ts", contains: "NUMERIC_RANGE_RE" },
];

const WIDE = ["\\u2013", "\\u2014", "\\u2015", "\u2013", "\u2014", "\u2015"];

function sourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return []; // a service that does not exist in this checkout
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) {
      // Tests legitimately build dash patterns to assert against.
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(join(dir, entry)));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test.")) {
      out.push(join(dir, entry));
    }
  }
  return out;
}

/** Every `[...]` character class in the source, with its line. */
function dashClasses(src: string): Array<{ line: number; cls: string; text: string }> {
  const found: Array<{ line: number; cls: string; text: string }> = [];
  const lines = src.split("\n");
  lines.forEach((text, i) => {
    // Character classes inside a regex literal. Deliberately loose: a
    // false positive costs one allowlist entry, a false negative costs a
    // customer's phone number.
    for (const m of text.matchAll(/\[([^\]\n]{0,120})\]/g)) {
      const cls = m[1];
      if (WIDE.some((w) => cls.includes(w))) found.push({ line: i + 1, cls, text: text.trim() });
    }
  });
  return found;
}

/** A literal ASCII hyphen in the class, in any position that matches one. */
function hasAsciiHyphen(cls: string): boolean {
  // Strip the escapes first so "\u2013" does not read as containing "-".
  const withoutEscapes = cls.replace(/\\u[0-9a-fA-F]{4}/g, "\u0001");
  // A "-" at the head or tail is a literal; between two chars it is a
  // range, which for wide dashes silently spans U+2013..U+2015 and is
  // just as much an accident.
  return withoutEscapes.includes("-");
}

describe("no dash-rewriting class contains an ASCII hyphen", () => {
  const files = ROOTS.flatMap(sourceFiles);

  it("scans a meaningful number of source files", () => {
    // If a refactor moves the tree, this test must fail loudly rather
    // than pass by scanning nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  it("every wide-dash character class is free of a literal hyphen", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const { line, cls, text } of dashClasses(src)) {
        if (!hasAsciiHyphen(cls)) continue;
        const allowed = ALLOWED.some((a) => file === a.file && text.includes(a.contains));
        if (allowed) continue;
        offenders.push(`${file}:${line}  [${cls}]\n    ${text}`);
      }
    }

    expect(
      offenders,
      offenders.length
        ? `A dash character class contains an ASCII hyphen. A "-" at the head of a\n` +
          `class is a LITERAL hyphen, so the class stops matching the wide dash it\n` +
          `is named for and starts matching every ordinary hyphen instead. Where\n` +
          `the class feeds a replace(), this rewrites "054-123-4567" to\n` +
          `"054, 123, 4567" in customer messages.\n\n` +
          `Spell wide dashes as \\u2013 \\u2014 \\u2015.\n\n` +
          offenders.join("\n\n")
        : "",
    ).toEqual([]);
  });

  it("the allowlisted numeric-range matcher is still where it says it is", () => {
    // An allowlist entry that no longer matches anything is an allowlist
    // entry that will silently excuse the wrong line later.
    for (const a of ALLOWED) {
      const src = readFileSync(join(REPO_ROOT, a.file), "utf8");
      expect(src, `${a.file} no longer contains ${a.contains}`).toContain(a.contains);
    }
  });
});

describe("the guards themselves still behave", () => {
  it("the shared guard catches a wide dash and ignores a hyphen", async () => {
    const { hasAiSignaturePunctuation } = await import("../lib/customer-text");
    expect(hasAiSignaturePunctuation("raw model text \u2014 unsanitized")).toBe(true);
    expect(hasAiSignaturePunctuation("Wi-Fi")).toBe(false);
    expect(hasAiSignaturePunctuation("054-123-4567")).toBe(false);
  });

  it("a dashed phone number survives sanitization byte-for-byte", async () => {
    const { sanitizeCustomerText } = await import("../lib/customer-text");
    expect(sanitizeCustomerText("call 054-123-4567 today")).toContain("054-123-4567");
  });
});
