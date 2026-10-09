/**
 * A Shopify live-chat visitor with no name is STORED as "Shopper on
 * <shop>.myshopify.com" - or "Signed-in shopper on …" - written once when
 * the conversation is made (services/ai shopify-chat-public.ts:497: their
 * real name needs a permission the app does not hold). Shown as stored, it
 * is a long English token on a Hebrew screen, and the shop is already the
 * channel's.
 *
 * Display only: the stored value stays the platform's. ONLY that exact
 * pattern is read this way - a real name that starts with "Shopper" is a
 * name. (Backend's assistant uses the same words in its rows, 2b55c3f0.)
 */
const STORED = /^(Signed-in shopper|Shopper) on [a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type ShopperKind = 'shopper' | 'signedInShopper';

/** Which stored shopper this is, or `null` for anything else (a real name). */
export function storedShopper(name: string | null | undefined): ShopperKind | null {
  const match = STORED.exec(name?.trim() ?? '');
  if (!match) return null;
  return match[1] === 'Shopper' ? 'shopper' : 'signedInShopper';
}

/**
 * The same, for a server loader: the words are read only when a stored
 * shopper is there - a real name asks nothing of the catalogue.
 */
export async function personNameLater(
  name: string | null | undefined,
  words: () => Promise<(kind: ShopperKind) => string>,
): Promise<string | null> {
  const kind = storedShopper(name);
  return kind ? (await words())(kind) : (name ?? null);
}

/** The name to show: the reader's words for a stored shopper, the name itself otherwise. */
export function personName(
  name: string | null | undefined,
  t: (kind: ShopperKind) => string,
): string | null {
  const kind = storedShopper(name);
  return kind ? t(kind) : (name ?? null);
}
