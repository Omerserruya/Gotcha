/**
 * Similar names are suggested, never linked (2026-10-11). Omer's own case:
 * Instagram "Omer Tsruya" and WhatsApp "Omer Serruya".
 */
import { describe, it, expect } from "vitest";
import { namesLookAlike, normalizeName } from "../lib/identity-links";

describe("namesLookAlike", () => {
  it.each([
    ["Omer Tsruya", "Omer Serruya"],     // Omer's two accounts: rr collapses, distance 2
    ["Dana Cohen", "dana kohen"],         // case, one letter
    ["Dana Levi", "Dana Levy"],
    ["Cohen Dana", "Dana Cohen"],         // same words, other order
    ["José Pérez", "Jose Perez"],         // diacritics
    ["  Dana   Cohen ", "Dana Cohen"],    // spaces
    ["Matan", "matan"],                   // one word, 4+ letters, the same
  ])("%s ~ %s", (a, b) => expect(namesLookAlike(a, b)).toBe(true));

  it.each([
    ["Matan Amran", "Matan Cohen"],       // same first name, different family
    ["Omer Serruya", "Dana Serruya"],     // same family, different first name
    ["GOTCHA", "Gotcha"],                 // generic
    ["קונה באתר", "קונה באתר"],           // generic ("buyer on the site")
    ["Instagram customer", "Instagram customer"],
    ["Avi", "avi"],                       // one short word says too little
    ["@omer.ts", "@omer.ts"],             // a handle is not a name
    ["Dana Ko", "Dana Ki"],               // last word under 4 letters
    ["Dana Peretz", "Dana Perry"],        // three letters apart: another family
  ])("%s !~ %s", (a, b) => expect(namesLookAlike(a, b)).toBe(false));

  it("Hebrew is transliterated, so the two scripts can meet", () => {
    expect(normalizeName("עומר")).toBe("aomr");
    expect(namesLookAlike("דנה כהן", "דנה כהן")).toBe(true);
  });
});
