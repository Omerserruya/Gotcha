import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "GOTCHA — תקשורת לקוחות מונעת בינה מלאכותית",
  description:
    "אחדו WhatsApp, Messenger ו-Instagram לתיבה חכמה אחת מבוססת AI. ניתוב חכם, עוזר AI ואנליטיקה בזמן אמת לצוותי שירות לקוחות.",
  alternates: {
    canonical: "/he",
    languages: { en: "/en", he: "/he" },
  },
  openGraph: {
    title: "GOTCHA — תקשורת לקוחות מונעת בינה מלאכותית",
    description:
      "אחדו WhatsApp, Messenger ו-Instagram לתיבה חכמה אחת מבוססת AI. ניתוב חכם, עוזר AI ואנליטיקה בזמן אמת.",
    url: "https://gotcha.co.il/he",
    locale: "he_IL",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function HebrewLanding() {
  return <LandingPage forcedLocale="he" />;
}
