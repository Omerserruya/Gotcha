/**
 * Frontend API helpers for the live call copilot — distinct from /lib/api.ts
 * to keep the voice surface area contained.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export type CueOutcome = "accepted" | "rejected" | "ignored";
export type CueKind = "missing_field" | "suggested_action" | "risk";

export interface CueOutcomePayload {
  cueId: string;
  conversationId: string;
  cueKind: CueKind;
  cueText: string;
  dedupKey: string;
  outcome: CueOutcome;
}

/**
 * Record a rep's reaction to a copilot cue. Fire-and-forget at the call
 * site — feedback is value-add, never load-bearing. The server returns 200
 * on success or 4xx on validation; we still resolve so the UI can move on.
 */
export async function postCueOutcome(
  token: string,
  payload: CueOutcomePayload,
): Promise<void> {
  try {
    await fetch(`${API_URL}/api/copilot/cue-outcome`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      // keepalive lets the request survive a tab close — handy because the
      // most common "ignored" path is the rep hanging up before clicking.
      keepalive: true,
    });
  } catch {
    // Swallow — see header comment.
  }
}
