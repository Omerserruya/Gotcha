import type { Metadata } from "next";
import { LegalLocaleProvider } from "./LegalKit";
import { LegalShell } from "./LegalShell";

export const metadata: Metadata = {
  title: "Trust Center | GOTCHA",
  description:
    "GOTCHA's legal and privacy documents: terms of service, privacy policy, cookie policy, data processing agreement, and subprocessors.",
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LegalLocaleProvider>
      <LegalShell>{children}</LegalShell>
    </LegalLocaleProvider>
  );
}
