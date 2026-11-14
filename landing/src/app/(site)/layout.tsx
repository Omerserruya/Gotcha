import type { Metadata } from 'next';
import CookieNotice from '@/components/CookieNotice';
import MetaPixel from '@/components/MetaPixel';
import { siteMetadata } from '@/lib/site-metadata';
import '../globals.css';
import '../site.css';

export const metadata: Metadata = siteMetadata;

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
        {/* Renders nothing. Loads the pixel only once the card above says it
            may, and reports each pushState navigation as its own page view. */}
        <MetaPixel />
      </body>
    </html>
  );
}
