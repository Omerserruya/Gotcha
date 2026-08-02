/**
 * Translation keys the compiler and the parity check both miss.
 *
 * Most keys are literals, so a scan finds them and the parity test keeps both
 * locales in step. These are built at runtime from a value the SERVER chose:
 *
 *     t(`checkout.decline.${summary.declineCategory}`)
 *
 * Nothing statically connects that template to the union the backend can
 * actually return. Add a fifth decline category in the service without adding
 * copy, and a customer whose card was refused sees `checkout.decline.WHATEVER`
 * on the payment page - raw, in whichever language they are reading. It would
 * pass typecheck, pass the parity test, and pass review.
 *
 * So the union is read from the backend source and every member checked in both
 * locales. It is a coupling across two packages; the alternative is trusting
 * that nobody ever extends an enum without remembering a JSON file in another
 * workspace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const REPO = join(SRC, "../..");

const en = JSON.parse(readFileSync(join(SRC, "i18n/en.json"), "utf8"));
const he = JSON.parse(readFileSync(join(SRC, "i18n/he.json"), "utf8"));

function lookup(dict: any, dotted: string): string | undefined {
  return dotted.split(".").reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

/** Read a string-literal union out of a TypeScript source file. */
function unionMembers(file: string, typeName: string): string[] {
  const text = readFileSync(join(REPO, file), "utf8");
  const m = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(text);
  if (!m) throw new Error(`${typeName} not found in ${file} - has it been renamed?`);
  return Array.from(m[1].matchAll(/"([A-Z_]+)"/g), (x) => x[1]);
}

describe("every decline the backend can report has copy", () => {
  const categories = unionMembers("services/billing/src/lib/decline-category.ts", "DeclineCategory");

  it("finds the union at all", () => {
    // If the type is renamed this throws above, which is the intent: a silently
    // empty list would make every check below vacuous.
    expect(categories.length).toBeGreaterThanOrEqual(4);
    expect(categories).toContain("DECLINED");
  });

  it.each(["en", "he"])("%s has a string for each of them", (locale) => {
    const dict = locale === "en" ? en : he;
    const missing = categories.filter((c) => typeof lookup(dict, `checkout.decline.${c}`) !== "string");
    // A customer reading this has just had their card refused. Showing them an
    // identifier is the worst moment to look broken.
    expect(missing, `${locale} is missing checkout.decline.{${missing.join(", ")}}`).toEqual([]);
  });

  it("says something different for each, so the category earns its place", () => {
    const strings = categories.map((c) => lookup(en, `checkout.decline.${c}`));
    // Four categories that all say "your payment was declined" would be four
    // ways of telling someone nothing.
    expect(new Set(strings).size).toBe(categories.length);
  });

  it("the Hebrew is actually translated", () => {
    for (const c of categories) {
      const e = lookup(en, `checkout.decline.${c}`);
      const h = lookup(he, `checkout.decline.${c}`);
      expect(h, `checkout.decline.${c} is identical in both locales`).not.toBe(e);
      expect(h, `checkout.decline.${c} is not Hebrew`).toMatch(/[֐-׿]/);
    }
  });
});

describe("the other dynamic key on the payment path", () => {
  it("the retry prompt exists in both locales", () => {
    // Rendered next to the decline itself, and only when retrying is possible.
    for (const [name, dict] of [["en", en], ["he", he]] as const) {
      expect(typeof lookup(dict, "checkout.decline.tryAnother"), `${name}`).toBe("string");
    }
  });
});
