/**
 * Shopify's install handles travel in cookies the BACKEND sets - on the
 * shared host, at `/`, HttpOnly - so the redirect back from Shopify carries
 * them to the backend. Our server calls the backend itself, so it hands the
 * intent on to the browser and sends the pending one back. Pure, so it is
 * tested without a request.
 */
export const INTENT_COOKIE = 'gotcha_shopify_intent';
export const PENDING_COOKIE = 'gotcha_shopify_pending';

export interface RelayedCookie {
  readonly value: string;
  readonly maxAge: number | undefined;
}

/** The named cookie out of `Set-Cookie` headers; `null` when absent or being cleared. */
export function cookieFrom(setCookies: readonly string[], name: string): RelayedCookie | null {
  for (const line of setCookies) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    if (!value) return null;
    const maxAge = attributes
      .map((a) => a.trim().match(/^max-age=(\d+)$/i)?.[1])
      .find((v) => v !== undefined);
    return { value, maxAge: maxAge === undefined ? undefined : Number(maxAge) };
  }
  return null;
}
