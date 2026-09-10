import type { Metadata } from 'next';
import CookieNotice from '@/components/CookieNotice';
import './globals.css';
import './site.css';

export const metadata: Metadata = {
  title: 'GOTCHA - Manage every customer interaction, end to end.',
  description:
    'From WhatsApp messages to phone calls, GOTCHA manages every customer interaction in one place, with AI employees tailored to your business, working alongside your team.',
  // Served from public/ rather than app/favicon.ico: the root optional
  // catch-all route answers /favicon.ico before the metadata route can.
  //
  // TWO files, not four, and the SVG is the one that matters.
  //
  // The previous arrangement offered a black PNG at `media="(prefers-color-
  // scheme: light)"` and a white one at `dark`. That is correct markup and
  // Chrome does not implement it - it ignores `media` on a favicon link and
  // picks by size and type instead - so a visitor in dark mode got the black
  // mark on a dark tab strip. Firefox and Safari honoured the query, which is
  // what made it look like a caching problem rather than a browser difference.
  //
  // favicon.svg carries both colourways inside one file, as a @media rule on a
  // fill, so nothing depends on the browser choosing correctly between files.
  // It is last because a browser that cannot use it needs to fall through to
  // the .ico above, which is the same mark in the dark colourway.
  icons: {
    icon: [
      { url: '/assets/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/assets/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/assets/favicon.ico',
    apple: '/assets/apple-touch-icon.png',
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
