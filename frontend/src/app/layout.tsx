import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  metadataBase: new URL("https://gotcha.co.il"),
  title: {
    default: "GOTCHA — AI-Powered Customer Communication",
    template: "%s | GOTCHA",
  },
  description:
    "Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox. Smart routing, co-pilot suggestions, and real-time analytics for customer support teams.",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "GOTCHA — AI-Powered Customer Communication",
    description:
      "Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox. Smart routing, co-pilot suggestions, and real-time analytics.",
    url: "https://gotcha.co.il",
    siteName: "GOTCHA",
    locale: "en_US",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "GOTCHA — AI-Powered Customer Communication",
    description:
      "Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox.",
    images: ["/logo.png"],
  },
  alternates: {
    languages: { en: "/en", he: "/he" },
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr">
      <body className="bg-gray-50 text-gray-900 min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
