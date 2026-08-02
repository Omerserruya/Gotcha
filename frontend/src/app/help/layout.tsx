"use client";

import { HelpLocaleProvider, HelpShell } from "./HelpKit";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <HelpLocaleProvider>
      <HelpShell>{children}</HelpShell>
    </HelpLocaleProvider>
  );
}
