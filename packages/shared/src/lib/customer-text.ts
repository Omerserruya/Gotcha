/**
 * Last-line customer-text sanitizer - the OUTBOX safety net.
 *
 * Generators are responsible for style (humanizeReply) and for groundedness
 * (validateGroundedMessage, which needs the verified facts that only exist at
 * generation time). This function is the guarantee that NO producer - present
 * or future, humanized or not - can put AI-signature punctuation in front of
 * a customer: it runs in the outgoing-worker on every outbound body, for
 * every channel, immediately before the provider send.
 *
 * Scope is deliberately narrow: character-level signature scrubbing only.
 * It never touches numbers, currencies, order ids, dates or wording, so it
 * can never alter a verified business fact.
 */
/**
 * Atomic values that punctuation/style rewriting must NEVER touch: URLs,
 * emails, ISO dates/timestamps, UUID-like ids, order refs, phone numbers,
 * currency-adjacent numbers. A live incident proved why: a dash-scrubbing
 * regex that matched ASCII hyphens turned every product URL
 * (urban-supply-… → "urban, supply, …"), ISO date (2026-07-08 →
 * "2026, 07, 08") and image UUID into comma soup. Style transforms now run
 * ONLY on the prose BETWEEN protected atoms; the atoms are swapped for
 * invisible-separator sentinels first and restored byte-for-byte after.
 */
const ATOM_RES: RegExp[] = [
  /\bhttps?:\/\/[^\s<>"')\]]+/gi,                             // URLs (path/query intact)
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,                            // emails
  /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, // ISO dates/timestamps
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
  /\+?\d[\d-]{6,}\d/g,                                        // phone-like digit runs incl. dashes
  /#\d{2,}/g,                                                 // order refs (#1004)
];

const SENTINEL = "⁣"; // INVISIBLE SEPARATOR - never occurs in chat text

// Placeholder indices are encoded in LETTERS (0→a … 9→j), not digits: a
// transform that rewrites digits (amount formatting, numeral localization)
// must not be able to corrupt the placeholder itself and drop the atom.
const IDX_ALPHABET = "abcdefghij";
function encodeIdx(i: number): string {
  return String(i).split("").map((d) => IDX_ALPHABET[Number(d)]).join("");
}
function decodeIdx(s: string): number {
  return Number(s.split("").map((c) => String(IDX_ALPHABET.indexOf(c))).join(""));
}

// Numeric range like "156-162", "156–162", "156 - 162", "2–3", "5 - 7".
// A live incident (snowboard sizing) had "156–162 ס״מ" corrupted to
// "156, 162 ס״מ" by the wide-dash sanitizer. Ranges are protected AND
// normalized to a plain ASCII hyphen so they survive hasAiSignaturePunctuation
// (which flags only wide dashes) and read naturally in every language.
const NUMERIC_RANGE_RE = /(\d+)\s*[-\u2013\u2014\u2015]\s*(\d+)/g;

/** Run a text transform with all atomic values shielded from it. */
export function withProtectedAtoms(text: string, transform: (prose: string) => string): string {
  const atoms: string[] = [];
  let masked = text;
  for (const re of ATOM_RES) {
    masked = masked.replace(re, (m) => {
      atoms.push(m);
      return `${SENTINEL}${encodeIdx(atoms.length - 1)}${SENTINEL}`;
    });
  }
  // Numeric ranges run AFTER the identifier atoms (phones/dates/order-refs are
  // already masked), and are normalized to a hyphen on capture.
  masked = masked.replace(NUMERIC_RANGE_RE, (_, a, b) => {
    atoms.push(`${a}-${b}`);
    return `${SENTINEL}${encodeIdx(atoms.length - 1)}${SENTINEL}`;
  });
  let out = transform(masked);
  out = out.replace(new RegExp(`${SENTINEL}([a-j]+)${SENTINEL}`, "g"), (_, i) => atoms[decodeIdx(i)] ?? "");
  return out;
}

export function sanitizeCustomerText(text: string | null | undefined): string {
  if (!text) return "";
  return withProtectedAtoms(text, (prose) => {
    let out = prose;
    // Wide dashes (em dash, en dash, horizontal bar) read as machine-written in
    // every audience language we serve. Replace clause-connector usage with a
    // comma, mirroring the reply path's humanizeReply. ASCII hyphens are NOT in
    // this class on purpose - and the atoms are shielded regardless.
    out = out.replace(/\s*[\u2013\u2014\u2015]\s*/g, ", ");
    // Tidy artifacts the substitution can leave behind.
    out = out.replace(/,\s*([.!?,\n])/g, "$1");
    out = out.replace(/,\s*,/g, ",").replace(/[ \t]{2,}/g, " ");
    return out;
  }).trim();
}

/** True when the text still carries an AI-signature wide dash. */
export function hasAiSignaturePunctuation(text: string | null | undefined): boolean {
  return /[\u2013\u2014\u2015]/.test(text ?? "");
}
