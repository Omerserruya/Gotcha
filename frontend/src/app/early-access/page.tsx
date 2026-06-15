import type { Metadata } from "next";
import EarlyAccessForm from "@/components/early-access/EarlyAccessForm";

export const metadata: Metadata = {
  title: "Get Early Access - GOTCHA",
  description:
    "Join the GOTCHA early access waitlist. Be the first to try the AI-powered unified inbox for WhatsApp Business, Instagram DMs, and Messenger. Free early access for customer support teams looking to automate multi-channel communication.",
  openGraph: {
    title: "Get Early Access - GOTCHA",
    description:
      "Join the GOTCHA early access waitlist. Be the first to try the AI-powered unified inbox for WhatsApp Business, Instagram, and Messenger.",
    url: "https://gotcha.co.il/early-access",
    type: "website",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "GOTCHA logo" }],
  },
};

export default function EarlyAccessPage() {
  return <EarlyAccessForm />;
}
