"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { getTenantSettings } from "@/lib/api";

export interface VoiceFlags {
  voiceCopilotEnabled: boolean;
  voiceInboxUiEnabled: boolean;
  voiceIncomingEnabled: boolean;
  /** True only when at least one CommunicationChannel(VOICE) is ACTIVE for
   *  the tenant. Used to short-circuit /api/voice-copilot/token attempts
   *  before they hit the network. */
  hasActiveVoiceChannel: boolean;
  /** True until the first fetch resolves (success or failure). */
  loading: boolean;
}

const DEFAULT_FLAGS: VoiceFlags = {
  voiceCopilotEnabled: false,
  voiceInboxUiEnabled: false,
  voiceIncomingEnabled: false,
  hasActiveVoiceChannel: false,
  loading: true,
};

// Process-wide cache so every component subscribing to flags shares one
// HTTP round-trip per session. Cleared on logout via the token effect.
let cachedFlags: VoiceFlags | null = null;
let inflight: Promise<VoiceFlags> | null = null;
const listeners = new Set<(f: VoiceFlags) => void>();

function emit(next: VoiceFlags) {
  cachedFlags = next;
  // Iterate via forEach to stay compatible with the es5 target — for...of
  // on Set requires downlevelIteration which the frontend tsconfig leaves off.
  listeners.forEach((l) => l(next));
}

async function fetchFlags(token: string): Promise<VoiceFlags> {
  if (cachedFlags && !cachedFlags.loading) return cachedFlags;
  if (inflight) return inflight;
  inflight = getTenantSettings(token)
    .then((res) => {
      const next: VoiceFlags = {
        voiceCopilotEnabled: !!res.data.voiceCopilotEnabled,
        voiceInboxUiEnabled: !!res.data.voiceInboxUiEnabled,
        voiceIncomingEnabled: !!res.data.voiceIncomingEnabled,
        hasActiveVoiceChannel: !!(res.data as { hasActiveVoiceChannel?: boolean }).hasActiveVoiceChannel,
        loading: false,
      };
      emit(next);
      return next;
    })
    .catch(() => {
      const next: VoiceFlags = { ...DEFAULT_FLAGS, loading: false };
      emit(next);
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Read tenant-scoped voice feature flags. Components MUST treat `loading`
 * as "render nothing" — never assume `false` means the feature is off, or
 * banners and call bars will flicker on every page load.
 */
export function useVoiceFlags(): VoiceFlags {
  const { token } = useAuth();
  const [flags, setFlags] = useState<VoiceFlags>(cachedFlags ?? DEFAULT_FLAGS);

  useEffect(() => {
    if (!token) {
      cachedFlags = null;
      setFlags({ ...DEFAULT_FLAGS, loading: false });
      return;
    }
    let alive = true;
    const sub = (next: VoiceFlags) => {
      if (alive) setFlags(next);
    };
    listeners.add(sub);
    fetchFlags(token).catch(() => {});

    // When a voice channel goes active (e.g. wizard step 4), invalidate the
    // process-wide cache and re-fetch so `hasActiveVoiceChannel` flips to
    // true without a full page refresh. VoiceCallContext will then see the
    // change and arm the Twilio token fetch.
    const onActivated = () => {
      cachedFlags = null;
      fetchFlags(token).catch(() => {});
    };
    window.addEventListener("voice-channel:activated", onActivated);

    return () => {
      alive = false;
      listeners.delete(sub);
      window.removeEventListener("voice-channel:activated", onActivated);
    };
  }, [token]);

  return flags;
}
