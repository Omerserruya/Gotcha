import type { Metadata, Viewport } from "next";
import { Inter, Assistant } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import Script from "next/script";                                                                                                                                                                         

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
    default: "GOTCHA — AI-Powered Customer Communication",
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
    title: "GOTCHA — AI-Powered Customer Communication",
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
    title: "GOTCHA — AI-Powered Customer Communication",
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
  return (
    <html lang="en" dir="ltr">
      <body className={`${inter.variable} ${assistant.variable} bg-gray-50 text-gray-900 min-h-screen`}>
        <Providers>{children}</Providers>
        <Script
          id="chatcenter-widget"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              window.__chatcenter = {
          widgetId: "widget_5a3961c3f5dc11493517ffac",
          apiUrl: "https://gotcha.co.il",
          color: "#733fee",
          iconUrl: " https://img.icons8.com/?size=48&id=4cjwkaJ1Zo0u&format=png",
        };
              var s = document.createElement("script");
              s.src = "https://gotcha.co.il/widget/chatcenter-widget.js";
              s.async = true;
              document.head.appendChild(s);
            `,
          }}
        />
      </body>
    </html>
  );
}
  