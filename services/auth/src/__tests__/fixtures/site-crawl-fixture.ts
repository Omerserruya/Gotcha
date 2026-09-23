/**
 * A fake site, used as the CONTROL for extracting the crawler out of
 * onboarding.ts.
 *
 * Deliberately offline. `safeFetch` blocks private and loopback addresses by
 * design, so a fixture HTTP server is not an option - the crawl orchestration
 * is therefore exercised by injecting the page fetcher, which also makes the
 * control cover the part that could actually drift: which URLs get requested,
 * the dedupe, the cap, and the text slicing.
 *
 * Email domains are `.invalid` on purpose. `detectEmailProviders` does a live
 * DNS MX lookup, and `.invalid` is reserved never to resolve, so the real code
 * path runs and its result is deterministic without a network.
 */
/** Home is padded past the 9000 boundary for the same reason. */
export const HOME_PADDING = " פרטים נוספים על החנות. ".repeat(500);

export const ORIGIN = "https://fixture-shop.example.com";

export const HOME_HTML = `<!doctype html><html lang="he"><head>
<script type="application/ld+json">{"@type":"Organization","email":"mailto:hello@fixture-shop.invalid","telephone":"+972-3-555-0100","sameAs":["https://instagram.com/fixtureshop"]}</script>
<meta name="generator" content="Shopify">
</head><body>
<h1>Fixture Shop</h1>
<p>אנחנו חנות מקוונת. משלוחים לכל הארץ.</p>
<a href="/pages/about">אודות</a>
<a href="/pages/faq">שאלות ותשובות</a>
<a href="/policies/refund-policy">מדיניות החזרות</a>
<a href="/blog/not-interesting">Blog</a>
<a href="https://elsewhere.example.org/offsite">Offsite</a>
<a href="/cart">Cart</a>
<a href="https://wa.me/972355501000">WhatsApp</a>
<a href="/pages/shipping">משלוחים</a>
<p>${HOME_PADDING}</p>
<script src="https://cdn.shopify.com/s/files/x.js"></script>
</body></html>`;

/** Pages the fake fetcher will answer for. Anything else 404s (returns null). */
export const PAGES: Record<string, string> = {
  [ORIGIN]: HOME_HTML,
  [`${ORIGIN}/pages/about`]: `<html><body><h2>About</h2><p>Founded in 2019. Contact support@fixture-shop.invalid</p></body></html>`,
  [`${ORIGIN}/pages/faq`]: `<html><body><h2>FAQ</h2><p>Shipping takes 3 days.</p></body></html>`,
  [`${ORIGIN}/policies/refund-policy`]: `<html><body><h2>Refunds</h2><p>14 days.</p></body></html>`,
  [`${ORIGIN}/contact`]: `<html><body><p>Call +972-3-555-0100</p></body></html>`,
  // LONG ON PURPOSE. Every other fixture page is shorter than the per-page
  // slice, so a change to the 2800 boundary produced identical output and the
  // control passed a mutation that altered what the AI service is sent. A page
  // that straddles the boundary is what makes that assertion real.
  [`${ORIGIN}/pages/shipping`]: `<html><body><h2>Shipping</h2><p>${"נשלח תוך שלושה ימי עסקים. ".repeat(400)}</p></body></html>`,
};


/** Strips markup exactly as fetchPageRaw does, so the fake matches the real one. */
export function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Records every URL asked for, so the control can assert the request set. */
export function makeFetcher() {
  const requested: string[] = [];
  const fetchPage = async (url: string): Promise<{ html: string; text: string } | null> => {
    requested.push(url);
    const html = PAGES[url] ?? PAGES[url.replace(/\/$/, "")];
    if (!html) return null;
    return { html: html.slice(0, 400000), text: strip(html) };
  };
  return { fetchPage, requested };
}
