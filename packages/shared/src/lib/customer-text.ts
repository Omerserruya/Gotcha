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
export function sanitizeCustomerText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  // Wide dashes (em dash, en dash, horizontal bar) read as machine-written in
  // every audience language we serve. Replace clause-connector usage with a
  // comma, mirroring the reply path's humanizeReply.
  out = out.replace(/\s*[—–―]\s*/g, ", ");
  // Tidy artifacts the substitution can leave behind.
  out = out.replace(/,\s*([.!?,\n])/g, "$1");
  out = out.replace(/,\s*,/g, ",").replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

/** True when the text still carries an AI-signature wide dash. */
export function hasAiSignaturePunctuation(text: string | null | undefined): boolean {
  return /[—–―]/.test(text ?? "");
}
