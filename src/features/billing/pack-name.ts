/**
 * A credit pack's name in the reader's language.
 *
 * The shelf sends `name` (the tenant's, English on dev - "1,000 credits") and
 * an optional `nameHe`. In Hebrew the Hebrew name, else the count said in
 * Hebrew - never the English name under a Hebrew page (the 14" sweep found
 * "credits" in the buy dialog). Every other language keeps the shelf's name.
 */
export function packName(
  pack: { readonly name: string; readonly nameHe?: string | null },
  locale: string,
  countSentence: () => string,
): string {
  if (locale !== 'he') return pack.name;
  return pack.nameHe?.trim() || countSentence();
}
