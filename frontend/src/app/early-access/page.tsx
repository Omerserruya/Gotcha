import type { Metadata } from "next";
import EarlyAccessForm from "@/components/early-access/EarlyAccessForm";

export const metadata: Metadata = {
  title: "Get Early Access — GOTCHA",
  description:
    "Join the GOTCHA early access waitlist. Unify WhatsApp, Messenger, and Instagram into one AI-powered inbox.",
  openGraph: {
    title: "Get Early Access — GOTCHA",
    description:
      "Join the GOTCHA early access waitlist. Be among the first to unify your customer messaging.",
    url: "https://gotcha.co.il/early-access",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function EarlyAccessPage() {
  return <EarlyAccessForm />;
}
