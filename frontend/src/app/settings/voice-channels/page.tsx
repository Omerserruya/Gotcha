"use client";

// The voice-channel LIST now lives in Settings → Channels (Voice section).
// Detail pages (/settings/voice-channels/[id]) and the connect wizard (/new)
// remain real routes; only this list view moved.
import { LegacyRedirect } from "@/components/LegacyRedirect";

export default function LegacyPage() {
  return <LegacyRedirect from="/settings/voice-channels" />;
}
