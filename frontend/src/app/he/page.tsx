import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "GOTCHA - תקשורת לקוחות מונעת בינה מלאכותית",
  description:
    "אחדו WhatsApp Business, הודעות Instagram ו-Facebook Messenger לתיבת דואר נכנס אחת מבוססת בינה מלאכותית. אוטומציה של שירות לקוחות עם ניתוב חכם, עוזר AI, ואנליטיקה בזמן אמת. ניהול נציגים מרובים בערוצי מסרים חברתיים מלוח בקרה אחד.",
  alternates: {
    canonical: "/he",
    languages: { en: "/en", he: "/he" },
  },
  openGraph: {
    title: "GOTCHA - תקשורת לקוחות מונעת בינה מלאכותית",
    description:
      "אחדו WhatsApp Business, הודעות Instagram ו-Messenger לתיבת דואר אחת מבוססת AI. ניתוב חכם, עוזר AI ואנליטיקה בזמן אמת לצוותי שירות לקוחות.",
    url: "https://gotcha.co.il/he",
    locale: "he_IL",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function HebrewLanding() {
  return (
    <>
      <LandingPage forcedLocale="he" />
    </>
  );
}
