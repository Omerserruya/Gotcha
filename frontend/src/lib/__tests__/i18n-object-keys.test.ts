/**
 * A translation key that holds a MAP must never be rendered directly.
 *
 * `shopifyChat.trigger` is an object of option labels
 * (`trigger.time_on_page`, `trigger.page_views`, …). Asking for it bare -
 * `t("shopifyChat.trigger")` - returns the object, and React throws
 * "Objects are not valid as a React child", taking the whole settings
 * section down with it.
 *
 * The mistake is easy to make and invisible until that section is opened,
 * so it is checked here across the whole app rather than fixed one crash
 * at a time. Ten such maps exist under `shopifyChat` alone.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const I18N = path.resolve(__dirname, "../../i18n");

/** Every dotted path in the catalogue whose value is an object, not a string. */
function objectPaths(node: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.add(dotted);
      objectPaths(value, dotted, out);
    }
  }
  return out;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("translation keys that hold maps", () => {
  const en = JSON.parse(fs.readFileSync(path.join(I18N, "en.json"), "utf8"));
  const maps = objectPaths(en);

  it("finds the maps it is meant to be guarding", () => {
    // A sanity check on the walker itself: if this ever returns nothing,
    // the test below would pass vacuously and guard nothing at all.
    expect(maps.size).toBeGreaterThan(20);
    expect(maps.has("shopifyChat.trigger")).toBe(true);
  });

  it("is never called with a map key anywhere in the app", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = fs.readFileSync(file, "utf8");
      // Only literal, single-argument calls: `t("a.b")`. A templated key
      // (`t(\`a.b.${x}\`)`) is exactly the correct usage and is not a
      // candidate here.
      //
      // Nor is a call that is immediately cast - `t("...") as unknown` is
      // a caller deliberately reading the map to iterate it, which is a
      // legitimate thing to do with one.
      const re = /\bt\(\s*"([^"]+)"\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const key = match[1];
        if (!maps.has(key)) continue;
        const after = src.slice(match.index + match[0].length, match.index + match[0].length + 12);
        if (/^\s+as\s/.test(after)) continue;
        const line = src.slice(0, match.index).split("\n").length;
        offenders.push(`${path.relative(SRC, file)}:${line} - t("${key}") returns an object`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
