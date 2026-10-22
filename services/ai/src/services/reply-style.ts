/**
 * The customer-facing reply style pass - ONE function for every AI text that
 * reaches a customer (live replies, oneshot acks, execution messages, and the
 * re-engagement follow-up). Moved out of ai-bot.service so the follow-up
 * generator applies the same pass instead of sending the model's raw text.
 */
import { withProtectedAtoms } from "@chatcenter/shared";

// Final humanizing pass on the customer-facing reply. Models love joining
// clauses with an em/en dash or a spaced hyphen ("…אשמח לעזור - מתי…"), which
// reads as machine-written. Prompt rules reduce it but don't eliminate it, so we
// also strip it deterministically here. Token-internal hyphens (phone numbers,
// "Wi-Fi", date ranges like 10-15) have NO surrounding spaces and are preserved.
export function humanizeReply(text: string | null): string | null {
  if (!text) return text;
  // ROOT-CAUSE NOTE (2026-07-20 live incident): a previous version of the dash
  // class here accidentally contained the ASCII hyphen, which rewrote EVERY
  // hyphen - inside product URLs (urban-supply-… → "urban, supply, …"), ISO
  // dates (2026-07-08 → "2026, 07, 08") and image UUIDs - into comma soup on
  // real WhatsApp messages. Two defenses now: the class holds ONLY true wide
  // dashes (U+2014 em, U+2013 en, U+2015 bar), and every transform runs with
  // atomic values (URLs, emails, dates, ids, phones) shielded byte-for-byte
  // via withProtectedAtoms.
  return withProtectedAtoms(text, (prose) => {
    let out = prose;
    // Wide dash used as a clause connector (with or without surrounding spaces).
    out = out.replace(/\s*[\u2013\u2014\u2015]\s*/g, ", ");
    // ASCII hyphen used as a dash: spaces on BOTH sides only. Token-internal
    // hyphens (Wi-Fi, ranges like 10-15) are untouched.
    out = out.replace(/(\S) +- +(\S)/g, "$1, $2");
    // Don't leave a stray ", " right before sentence punctuation or newline.
    out = out.replace(/,\s*([.!?,\n])/g, "$1");
    // Collapse the accidental ", ," and trailing/leading artifacts.
    out = out.replace(/,\s*,/g, ",").replace(/[ \t]{2,}/g, " ");
    return out;
  }).trim();
}
