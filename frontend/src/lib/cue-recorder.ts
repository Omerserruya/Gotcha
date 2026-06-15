"use client";

/**
 * Cue Recorder - captures everything the live copilot did during a call so
 * the replay page can reconstruct it after hangup.
 *
 * Source: socket events (`voice.transcript`, `voice.frame.updated`,
 * `copilot.cues.updated`) + local cue-outcome actions the rep performs.
 *
 * Sink: `sessionStorage` for the live buffer (fast, cheap) and
 * `localStorage` for the persisted timeline at call-end so /replay can
 * load even after a hard refresh. Keyed by `sessionId`. LRU cap of 20
 * sessions to keep storage bounded (~5MB ceiling worst case).
 *
 * No backend dependency. Replay quality matches what was actually
 * delivered to the rep - if the cue never made it to the socket, it
 * never made it to the recorder.
 */

import { useEffect, useRef } from "react";
import { getSocket } from "@/lib/socket";

const LS_INDEX = "copilot.replay.index";
const LS_KEY = (sessionId: string) => `copilot.replay.${sessionId}`;
const SS_KEY = (sessionId: string) => `copilot.replay.live.${sessionId}`;
const LRU_CAP = 20;

export type TimelineEventKind =
  | "transcript"
  | "frame"
  | "cues_emitted"
  | "cue_outcome"
  | "call_started"
  | "call_ended";

export interface TimelineEvent {
  t: number;            // ms since epoch
  kind: TimelineEventKind;
  data: unknown;
}

interface RecorderHandle {
  push: (kind: TimelineEventKind, data: unknown) => void;
  flush: () => void;
  read: () => TimelineEvent[];
}

const memBuffers = new Map<string, TimelineEvent[]>();

function bufferFor(sessionId: string): TimelineEvent[] {
  let b = memBuffers.get(sessionId);
  if (!b) {
    b = readSession(sessionId);
    memBuffers.set(sessionId, b);
  }
  return b;
}

function readSession(sessionId: string): TimelineEvent[] {
  try {
    const live = sessionStorage.getItem(SS_KEY(sessionId));
    if (live) return JSON.parse(live);
    const persisted = localStorage.getItem(LS_KEY(sessionId));
    if (persisted) return JSON.parse(persisted);
  } catch {
    /* ignore */
  }
  return [];
}

function writeLive(sessionId: string, events: TimelineEvent[]): void {
  try {
    sessionStorage.setItem(SS_KEY(sessionId), JSON.stringify(events));
  } catch {
    /* quota - drop oldest 25%, retry */
    const trimmed = events.slice(Math.floor(events.length * 0.25));
    try {
      sessionStorage.setItem(SS_KEY(sessionId), JSON.stringify(trimmed));
      memBuffers.set(sessionId, trimmed);
    } catch {
      /* give up - recorder is best-effort */
    }
  }
}

function persistFinal(sessionId: string, events: TimelineEvent[]): void {
  try {
    localStorage.setItem(LS_KEY(sessionId), JSON.stringify(events));
    sessionStorage.removeItem(SS_KEY(sessionId));
    touchIndex(sessionId);
  } catch {
    /* ignore */
  }
}

function touchIndex(sessionId: string): void {
  let idx: string[];
  try {
    idx = JSON.parse(localStorage.getItem(LS_INDEX) || "[]");
  } catch {
    idx = [];
  }
  const without = idx.filter((s) => s !== sessionId);
  const next = [sessionId, ...without].slice(0, LRU_CAP);
  // Evict anything that fell off the LRU.
  for (const evicted of without.slice(LRU_CAP - 1)) {
    try {
      localStorage.removeItem(LS_KEY(evicted));
    } catch {
      /* ignore */
    }
  }
  localStorage.setItem(LS_INDEX, JSON.stringify(next));
}

export function createRecorder(sessionId: string): RecorderHandle {
  return {
    push(kind, data) {
      const buf = bufferFor(sessionId);
      buf.push({ t: Date.now(), kind, data });
      // Throttle writes - sessionStorage every 20 events is plenty.
      if (buf.length % 20 === 0) writeLive(sessionId, buf);
    },
    flush() {
      const buf = bufferFor(sessionId);
      writeLive(sessionId, buf);
      persistFinal(sessionId, buf);
    },
    read() {
      return bufferFor(sessionId).slice();
    },
  };
}

export function readReplay(sessionId: string): TimelineEvent[] {
  return readSession(sessionId);
}

export function listReplays(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LS_INDEX) || "[]");
  } catch {
    return [];
  }
}

/**
 * React hook - call from VoiceCallContext (or any per-call provider). Wires
 * socket events into the recorder for the duration of `sessionId`. Returns
 * a `recordOutcome` helper to log the rep's cue actions into the same
 * timeline (so replay shows accept/dismiss alongside the cue itself).
 */
export function useCueRecorder(
  sessionId: string | null,
  conversationId: string | null,
): { recordOutcome: (data: unknown) => void } {
  const handleRef = useRef<RecorderHandle | null>(null);

  useEffect(() => {
    if (!sessionId || !conversationId) return;
    const socket = getSocket();
    if (!socket) return;

    const rec = createRecorder(sessionId);
    handleRef.current = rec;
    rec.push("call_started", { sessionId, conversationId });

    const onTranscript = (d: unknown) => rec.push("transcript", d);
    const onFrame = (d: unknown) => rec.push("frame", d);
    const onCues = (d: unknown) => rec.push("cues_emitted", d);

    socket.on("voice.transcript", onTranscript);
    socket.on("voice.frame.updated", onFrame);
    socket.on("copilot.cues.updated", onCues);

    return () => {
      socket.off("voice.transcript", onTranscript);
      socket.off("voice.frame.updated", onFrame);
      socket.off("copilot.cues.updated", onCues);
      rec.push("call_ended", { sessionId });
      rec.flush();
      handleRef.current = null;
    };
  }, [sessionId, conversationId]);

  return {
    recordOutcome: (data) => handleRef.current?.push("cue_outcome", data),
  };
}
