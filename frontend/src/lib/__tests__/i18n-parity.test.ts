import { describe, it, expect } from "vitest";
import en from "../../i18n/en.json";
import he from "../../i18n/he.json";

// Fails when a translation key exists in one locale but not the other for the
// blocks this IA round owns - the Hebrew UI must never fall back to raw keys.
const BLOCKS = [
  "users",
  "businessPage",
  "setupChecklist",
  "channels",
  // Per-number WhatsApp management. Registered here so a missing Hebrew string
  // fails the suite instead of rendering a raw key at a customer.
  "whatsappNumbers",
  "departments",
  "usage",
  "settings.nav",
  "settings.billing",
  "settings.people",
  "settings.businessSystems",
];

function keysOf(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k));
}

function resolve(dict: unknown, path: string): unknown {
  return path.split(".").reduce((o: any, k) => o?.[k], dict);
}

describe("i18n parity (en ↔ he)", () => {
  for (const block of BLOCKS) {
    it(`${block}: identical key structure in both locales`, () => {
      const enBlock = resolve(en, block);
      const heBlock = resolve(he, block);
      expect(enBlock, `${block} missing in en`).toBeTruthy();
      expect(heBlock, `${block} missing in he`).toBeTruthy();
      const enKeys = keysOf(enBlock).sort();
      const heKeys = keysOf(heBlock).sort();
      expect(heKeys).toEqual(enKeys);
    });
  }

  it("no em/en dashes in the customer-facing blocks (both locales)", () => {
    for (const block of BLOCKS) {
      for (const dict of [en, he]) {
        const flat = keysOf(resolve(dict, block)).map((k) => String(resolve(dict, `${block}.${k}`) ?? ""));
        void flat;
      }
    }
    const scan = (obj: unknown): string[] =>
      typeof obj === "string" ? [obj] : obj && typeof obj === "object" ? Object.values(obj).flatMap(scan) : [];
    for (const block of BLOCKS) {
      for (const [name, dict] of [["en", en], ["he", he]] as const) {
        for (const text of scan(resolve(dict, block))) {
          expect(text, `${name}:${block} contains an em/en dash: ${text}`).not.toMatch(/[\u2014\u2013]/);
        }
      }
    }
  });
});
