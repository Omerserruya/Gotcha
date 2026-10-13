import type { Metadata } from 'next';
import './tokens.css';

export const metadata: Metadata = {
  // Overridden per campaign. A page that ships with this title has not been
  // finished.
  title: 'GOTCHA',

  /*
   * NOINDEX FOR THE WHOLE HOST, and this is a decision rather than a default.
   *
   * Campaign pages are paid-traffic destinations. They restate the marketing
   * site's claims in campaign-specific wording, they exist for the length of a
   * flight, and they are deleted afterwards. Indexed, they would compete with
   * gotcha.co.il for our own terms while the flight runs and leave dead pages
   * in results after it ends.
   *
   * public/robots.txt says the same thing, and the two are not redundant:
   * robots.txt asks a crawler not to FETCH, this asks it not to INDEX. A page
   * linked from elsewhere can be indexed without ever being fetched, and only
   * the meta tag stops that.
   *
   * A campaign that genuinely wants organic traffic should export its own
   * `metadata` with `robots: { index: true }` - and should probably be a page
   * on gotcha.co.il instead.
   */
  robots: { index: false, follow: false },

  icons: {
    icon: [16, 32, 48, 96].map((n) => ({
      url: `/assets/favicon-${n}.png`,
      sizes: `${n}x${n}`,
      type: 'image/png',
    })),
    shortcut: '/assets/favicon.ico',
    apple: '/assets/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          The same families the marketing site loads, plus Heebo, which the
          Hebrew campaign pages set on `body`. One stylesheet request covers all
          of them and a browser downloads a font file only for the families the
          rendered text actually uses, so a page pays only for what it shows.

          Beyond that: the marketing families are here so a visitor who
          arrives here from an ad and continues to gotcha.co.il does not see the
          type change under them. Loaded from Google rather than self-hosted
          because that is what the marketing site does and a second, differently
          served copy of Archivo is how two sites end up rendering it
          differently.
        */}
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Heebo:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
