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
  // Two colourways, chosen by the browser's theme. The design's mark comes in a
  // white version and a black one, and a tab strip is light for most people -
  // shipping only the white one would leave the tab looking empty. The .ico
  // stays last as the fallback for anything that ignores `media`.
  icons: {
    icon: [
      { url: '/assets/favicon-dark-32.png', media: '(prefers-color-scheme: light)', type: 'image/png' },
      { url: '/assets/favicon-light-32.png', media: '(prefers-color-scheme: dark)', type: 'image/png' },
      { url: '/assets/favicon.ico' },
    ],
    shortcut: '/assets/favicon.ico',
    apple: '/assets/favicon-dark-180.png',
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
