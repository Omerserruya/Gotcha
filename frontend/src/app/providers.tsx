"use client";

import { AuthProvider } from "@/context/AuthContext";
import { PermissionsProvider } from "@/context/PermissionsContext";
import { I18nProvider } from "@/context/I18nContext";
import { VoiceCallProvider } from "@/context/VoiceCallContext";
import { VoiceSessionsProvider } from "@/contexts/VoiceSessionsContext";
import { ActiveCallWidget } from "@/components/voice/ActiveCallWidget";
import { IncomingCallBannerMobile } from "@/components/voice/IncomingCallBanner";
import { ActiveCallBar } from "@/components/voice/ActiveCallBar";
import { MfaEnrollmentGate } from "@/components/MfaEnrollmentGate";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AuthProvider>
        <PermissionsProvider>
        <VoiceCallProvider>
          {/* VoiceSessionsProvider holds the tenant-wide RINGING + live
              snapshot for Phase-1 Live Call CoPilot. Components inside
              gate themselves on the tenant feature flags - when disabled
              they render null so non-rollout tenants see today's UI. */}
          <VoiceSessionsProvider>
            {children}
            <ActiveCallWidget />
            <IncomingCallBannerMobile />
            <ActiveCallBar />
            {/* Hierarchical MFA enforcement: blocks the app with an enrolment
                gate when the user's role + tenant policy require MFA and they
                have not enrolled. Renders nothing otherwise. */}
            <MfaEnrollmentGate />
          </VoiceSessionsProvider>
        </VoiceCallProvider>
        </PermissionsProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
