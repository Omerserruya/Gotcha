"use client";

import { AuthProvider } from "@/context/AuthContext";
import { I18nProvider } from "@/context/I18nContext";
import { VoiceCallProvider } from "@/context/VoiceCallContext";
import { ActiveCallWidget } from "@/components/voice/ActiveCallWidget";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AuthProvider>
        <VoiceCallProvider>
          {children}
          <ActiveCallWidget />
        </VoiceCallProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
