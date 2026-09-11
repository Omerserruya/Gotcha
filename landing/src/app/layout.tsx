import type { Metadata } from 'next';
import CookieNotice from '@/components/CookieNotice';
import { ICON_VERSION } from '@/generated/icon-version';
import './globals.css';
import './site.css';

export const metadata: Metadata = {
  title: 'GOTCHA - Manage every customer interaction, end to end.',
  description:
    'From WhatsApp messages to phone calls, GOTCHA manages every customer interaction in one place, with AI employees tailored to your business, working alongside your team.',
  // Served from public/ rather than app/favicon.ico: the root optional
  // catch-all route answers /favicon.ico before the metadata route can.
  //
  // PNG, at the four sizes a browser asks for: the mark itself, white, on a
  // transparent ground - the file that was supplied, not a version of it.
  //
  // Two theme-aware attempts came before it and both failed on the same
  // browser. A black PNG at `media="(prefers-color-scheme: light)"` beside a
  // white one at `dark` is correct markup that Chrome does not implement - it
  // ignores `media` on a favicon link entirely. Putting both colourways inside
  // one SVG behind a @media rule looked like the answer, and Chromium honours
  // that rule in a page and even for an <img>, but NOT in the restricted path
  // it rasterises a favicon through: there it takes the light branch and paints
  // the ink mark onto a dark tab strip. Firefox and Safari honoured it both
  // times, which is exactly what made it keep looking fixed.
  //
  // A tile in the accent was tried next and solved it, by inventing a
  // background - which is a design decision, and not one this file gets to
  // make. So the icon is the white mark, the trade-off stated rather than
  // designed around: it reads on a dark tab strip and on the dark chrome most
  // browsers ship with, and it is faint on a light one.
  //
  // The SVG is gone either way; with no colourway to choose it had no job left.
  // favicon.ico is not declared here but is still generated: a browser with no
  // icon in the markup asks for it by path, and so do crawlers and link
  // unfurlers that never read the page.
  //
  // The `?v=` is a content hash. Cloudflare caches /assets/* at the edge for
  // four hours and keys on the whole URL, so the first tile deploy reached the
  // origin while every visitor still got the old icon - cf-cache-status HIT,
  // age 1128. The hash changes the key the moment the bytes do.
  icons: {
    icon: [16, 32, 48, 96].map((n) => ({
      url: `/assets/favicon-${n}.png?v=${ICON_VERSION}`,
      sizes: `${n}x${n}`,
      type: 'image/png',
    })),
    shortcut: `/assets/favicon.ico?v=${ICON_VERSION}`,
    apple: `/assets/apple-touch-icon.png?v=${ICON_VERSION}`,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        {/* Sits above every page, including the compiled landing, because the
            first visit is what it is asking about. */}
        <CookieNotice />
      </body>
    </html>
  );
}
