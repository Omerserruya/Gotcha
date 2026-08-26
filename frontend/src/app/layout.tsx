import type { Metadata, Viewport } from "next";
import { Inter, Assistant } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { LOCALE_BOOT_SCRIPT } from "@/lib/locale-boot";
import ChatWidget from "@/components/landing/ChatWidget";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const assistant = Assistant({ subsets: ["hebrew", "latin"], variable: "--font-assistant", display: "swap" });

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  metadataBase: new URL("https://gotcha.co.il"),
  title: {
    default: "GOTCHA - AI-Powered Customer Communication",
    template: "%s | GOTCHA",
  },
  description:
    "GOTCHA unifies WhatsApp Business, Instagram DMs, and Facebook Messenger into one AI-powered unified inbox. Automate customer support with smart routing, AI co-pilot suggestions, and real-time analytics. The best omnichannel customer communication platform for teams managing multiple agents across social messaging channels.",
  keywords: [
    "unified inbox",
    "whatsapp business multiple agents",
    "ai customer support platform",
    "omnichannel messaging",
    "whatsapp business inbox",
    "customer support automation",
    "instagram dm management",
    "facebook messenger business",
    "ai chatbot customer service",
    "multi-channel customer communication",
    "whatsapp crm",
    "social media customer support",
    "team inbox whatsapp",
    "customer service automation software",
    "ai-powered helpdesk",
  ],
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "GOTCHA - AI-Powered Customer Communication",
    description:
      "Unify WhatsApp Business, Instagram DMs, and Messenger into one AI-powered inbox. Smart routing, AI co-pilot, and real-time analytics for customer support teams.",
    url: "https://gotcha.co.il",
    siteName: "GOTCHA",
    locale: "en_US",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "GOTCHA - AI-Powered Customer Communication",
    description:
      "Unify WhatsApp Business, Instagram DMs, and Messenger into one AI-powered unified inbox for customer support teams.",
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
  // `lang`/`dir` are the pre-JS defaults; the script below corrects them before
  // the first paint, and I18nContext keeps them in sync afterwards.
  //
  // These were left hardcoded with only the post-hydration effect to fix them,
  // so every Hebrew page load flashed left-to-right. Resolving it server-side
  // would read better but `cookies()` in a root layout makes every page
  // dynamic, and this app statically generates its public pages. See
  // lib/locale-boot.ts.
  return (
    <html lang="en" dir="ltr">
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />
      </head>
      <body className={`${inter.variable} ${assistant.variable} bg-gray-50 text-gray-900 min-h-screen`}>
        <Providers>
          {children}
          {/* Mounted once for the whole site rather than per page: it is a
              single page app, so a widget injected by one page stays on
              screen on the next one. Deciding here means one place answers
              which pages it belongs on - see ChatWidget. */}
          <ChatWidget />
        </Providers>
      </body>
    </html>
  );
}
  