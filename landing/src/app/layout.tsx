import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GOTCHA - Manage every customer interaction, end to end.',
  description:
    'From WhatsApp messages to phone calls, GOTCHA manages every customer interaction in one place, with AI employees tailored to your business, working alongside your team.',
  // Served from public/ rather than app/favicon.ico: the root optional
  // catch-all route answers /favicon.ico before the metadata route can.
  icons: { icon: '/assets/favicon.ico', shortcut: '/assets/favicon.ico' },
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
      <body>{children}</body>
    </html>
  );
}
