/**
 * The widget's direction rules must agree with the server's.
 *
 * `frontend/public/widget/gotcha-shopify-chat.js` restates
 * `packages/shared/src/lib/text-direction.ts` in ES5, because the
 * storefront bundle ships without a bundler and cannot import the
 * workspace package. Restating a rule is only safe if drift is caught,
 * which is what this file is for: it loads BOTH and fails the moment they
 * disagree on any case in the table.
 *
 * Drift here is not cosmetic. The two implementations decide what a
 * shopper sees (widget) and what the inbox, the agent preview and any
 * server-rendered surface see (shared). A message that renders RTL in one
 * and LTR in the other is a bug nobody can reproduce from one side.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import * as server from "../../../../../packages/shared/src/lib/text-direction";

const WIDGET_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../../../public/widget/gotcha-shopify-chat.js"),
  "utf8",
);

let client: any;

beforeAll(() => {
  // eslint-disable-next-line no-eval
  (0, eval)(WIDGET_SOURCE);
  client = (window as any).__gotchaBidi;
});

/**
 * The table is the specification. Every row is a shape that has actually
 * turned up in storefront traffic or is one substitution away from it.
 */
const TEXTS: string[] = [
  // Single script
  "שלום, אני מחפש נעליים",
  "מרحبا، أبحث عن حذاء رياضي",
  "سلام، دنبال یک کفش ورزشی هستم",
  "سلام، میں ایک جوتا تلاش کر رہا ہوں",
  "Hi, I am looking for running shoes",
  "こんにちは、靴を探しています",
  "Здравствуйте, ищу кроссовки",
  "Γεια σας, ψάχνω παπούτσια",
  // No strong characters
  "",
  "   ",
  "👍",
  "42",
  "!!!",
  "... 3.14 ...",
  "?!?!",
  // Mixed
  "אני מחפש משהו כמו Nike Air Max 90",
  "רוצה את Cloud Pro Runner",
  "The שלום hoodie is nice and warm",
  "הנה הקישור https://demo-store.myshopify.com/products/cloud-pro",
  "בקרו כאן https://shop.example.com/products/x ותודה",
  "אפשר לשלוח לי ל support@demo-store.com",
  "המחיר הוא $120.00 ואפשר גם 149.99 USD",
  "המק״ט הוא AIR-MAX-90 נכון?",
  "תתקשרו אליי +972 54 123 4567",
  "أريد شراء Cloud Pro Runner من فضلك",
  "https://demo-store.myshopify.com/products/cloud-pro",
  "dana@example.com",
  "יש לי 3 מוצרים בסל",
  "Order #1004 בוטלה בהצלחה",
  "המחיר ₪49 בלבד",
  "מצאתי שלוש אפשרויות:\n1. נעל ריצה\n2. Cloud Pro Runner\n3. סנדל",
  "Total: 249.90 ILS for SKU GTX-1080-TI",
];

const LOCALES: Array<string | null> = [
  "he", "he-IL", "he_IL", "iw", "ar", "ar-SA", "fa", "fa-IR", "ur", "ur-PK",
  "ps", "sd", "ug", "ckb", "yi", "dv",
  "en", "en-US", "fr", "ja", "ru", "", "   ", "xx", null,
];

describe("detectScriptDirection parity", () => {
  it.each(TEXTS.map((t) => [t || "(empty)", t] as const))("agrees on %s", (_label, text) => {
    expect(client.detectScriptDirection(text)).toBe(server.detectScriptDirection(text));
  });

  it("agrees on null and undefined", () => {
    expect(client.detectScriptDirection(null)).toBe(server.detectScriptDirection(null));
    expect(client.detectScriptDirection(undefined)).toBe(server.detectScriptDirection(undefined));
  });
});

describe("countStrongCharacters parity", () => {
  it("agrees on every case in the table", () => {
    for (const text of TEXTS) {
      expect(client.countStrongCharacters(text)).toEqual(server.countStrongCharacters(text));
    }
  });
});

describe("stripNeutralAtoms parity", () => {
  it("agrees on every case in the table", () => {
    for (const text of TEXTS) {
      expect(client.stripNeutralAtoms(text)).toBe(server.stripNeutralAtoms(text));
    }
  });
});

describe("isRtlLocale / directionForLocale parity", () => {
  it("agrees on every locale in the table", () => {
    for (const locale of LOCALES) {
      expect(client.isRtlLocale(locale)).toBe(server.isRtlLocale(locale));
      expect(client.directionForLocale(locale)).toBe(server.directionForLocale(locale));
    }
  });
});

describe("segmentBidiText parity", () => {
  it("agrees on every case in the table", () => {
    for (const text of TEXTS) {
      expect(client.segmentBidiText(text)).toEqual(server.segmentBidiText(text));
      expect(client.needsBidiIsolation(text)).toBe(server.needsBidiIsolation(text));
    }
  });
});

describe("resolveMessageDirection parity", () => {
  const OVERRIDES = [undefined, "auto", "rtl", "ltr"] as const;
  const CONTENT_LOCALES = [undefined, "he", "en", "ar", ""] as const;
  const CONVERSATION_LOCALES = [undefined, "he", "en"] as const;
  const WIDGET_LOCALES = [undefined, "he", "en", "ar-EG"] as const;

  it("agrees across the whole cross-product of the chain", () => {
    // ~34 texts x 4 x 5 x 3 x 4 - exhaustive rather than sampled, because
    // the failure mode is one rung of the chain quietly diverging.
    let compared = 0;
    for (const text of TEXTS) {
      for (const override of OVERRIDES) {
        for (const contentLocale of CONTENT_LOCALES) {
          for (const conversationLocale of CONVERSATION_LOCALES) {
            for (const widgetLocale of WIDGET_LOCALES) {
              const input = { override, contentLocale, text, conversationLocale, widgetLocale };
              expect(client.resolveMessageDirection(input)).toEqual(
                server.resolveMessageDirection(input as any),
              );
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });
});

describe("shared constants parity", () => {
  it("uses the same dominance threshold", () => {
    expect(client.RTL_SHARE_THRESHOLD).toBe(server.RTL_SHARE_THRESHOLD);
  });
});
