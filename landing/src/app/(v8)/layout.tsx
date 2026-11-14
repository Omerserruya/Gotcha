import type { Metadata } from 'next';
import CookieNotice from '@/components/CookieNotice';
import MetaPixel from '@/components/MetaPixel';
import { FONT_HREF, LANG_SCRIPT, MOTION_SCRIPT, SCROLL_TOP_SCRIPT } from '@/generated/home/head';
import { siteMetadata } from '@/lib/site-metadata';
import './v8.css';

/**
 * The home's own root layout.
 *
 * `/` and `/he` are the v8 design; every other page is still the previous one.
 * The two designs' global stylesheets cannot share a document (both set `*`,
 * `body` and `a`), so each has a root layout of its own. Next treats a move
 * between two root layouts as a full page load, which is what keeps them apart.
 *
 * Same title, description and icons as the rest of the site.
 */
export const metadata: Metadata = siteMetadata;

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    // The head scripts below set lang, data-lang and the fx / nofx class on
    // <html> before React hydrates; those attributes are theirs.
    <html lang="he" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={FONT_HREF} rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: SCROLL_TOP_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LANG_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: MOTION_SCRIPT }} />
      </head>
      <body>
        {children}
        <CookieNotice />
        <MetaPixel />
      </body>
    </html>
  );
}
