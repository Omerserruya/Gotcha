"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { postCueOutcome, type CueKind, type CueOutcome } from "@/lib/api-copilot";
import { useCopilotProfile, type CopilotProfile, type CopilotTier } from "@/lib/copilot-prefs";

/**
 * Live Call Copilot - projected cues panel.
 *
 * Subscribes to `copilot.cues.updated` and renders cues across three lanes
 * (pulse / direction / strategy). Tier-aware (junior/mid/senior) via
 * useCopilotProfile - senior gets whisper mode (pulse only, no animation,
 * tighter cooldown), junior gets all lanes + more guidance.
 *
 * UX behavior:
 *   - Entrance: 200ms fade + slide-in (skipped for senior tier).
 *   - Decay bar: per-cue progress sliver tracks time-to-expire.
 *   - Stale fade: cues older than profile.staleAfterMs dim to 0.5.
 *   - Cooldown: same dedup-prefix within sameKindCooldownMs renders muted.
 *   - Suppression badge: shows "×N" if N recent same-prefix cues were dismissed.
 *   - Keyboard: ↑/↓ navigates, Enter accepts, Esc dismisses focused cue.
 *   - Micro-feedback: 200ms emerald ring on accept, brief shake on dismiss.
 *   - High-intensity: ≥2 pulse cues live → non-pulse lanes dim to 0.55.
 *   - Silence: 15s with no live cues during an active call → subtle "listening" dot.
 */

interface ProjectedCue {
  id: string;
  conversationId: string;
  kind: CueKind;
  lane: "pulse" | "direction" | "strategy";
  text: string;
  rationale: string;
  score: number;
  rawScore: number;
  dedupKey: string;
  goal: string;
  expiresAt: string;
  sourceFrameVersion: number;
}

interface Payload {
  conversationId?: string;
  cues?: ProjectedCue[];
}

interface InternalCue extends ProjectedCue {
  /** Local timestamp the cue first arrived in this client. */
  surfacedAt: number;
  /** Cooldown applies until this timestamp - render muted until then. */
  mutedUntil: number;
}

interface Props {
  conversationId: string | null;
}

const FLASH_MS = 220;
const SHAKE_MS = 180;
const SILENCE_MS = 15_000;

export function CueLanesCard({ conversationId }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const { profile, setTier } = useCopilotProfile();
  const [cues, setCues] = useState<InternalCue[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [flash, setFlash] = useState<{ key: string; kind: "accept" | "reject" } | null>(null);
  // Initialised to 0 so the static-export build and first client render
  // agree; the 1s ticker effect immediately bumps it to real Date.now().
  const [nowTick, setNowTick] = useState(0);

  /** dedupKeys this rep has already actioned this session. */
  const resolvedRef = useRef<Set<string>>(new Set());
  /** dedup-prefix → last surfaced ms, for cooldown. */
  const prefixLastSurfaceRef = useRef<Map<string, number>>(new Map());
  /** dedup-prefix → recent dismissals count (decays every 60s). */
  const dismissCountRef = useRef<Map<string, number>>(new Map());

  // ─── helpers ─────────────────────────────────────────────────
  const prefix = (k: string) => k.split(":")[0] || k;

  // ─── socket subscription ─────────────────────────────────────
  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;

    const onCues = (data: unknown) => {
      const d = data as Payload | undefined;
      if (!d || d.conversationId !== conversationId) return;
      if (!Array.isArray(d.cues) || d.cues.length === 0) return;

      const now = Date.now();
      setCues((prev) => {
        const byKey = new Map(prev.map((c) => [c.dedupKey, c]));
        for (const c of d.cues!) {
          if (resolvedRef.current.has(c.dedupKey)) continue;

          const p = prefix(c.dedupKey);
          const lastP = prefixLastSurfaceRef.current.get(p) ?? 0;
          const cooldownLeft = lastP + profile.sameKindCooldownMs - now;
          const mutedUntil = cooldownLeft > 0 ? now + cooldownLeft : 0;
          prefixLastSurfaceRef.current.set(p, now);

          const existing = byKey.get(c.dedupKey);
          byKey.set(c.dedupKey, {
            ...c,
            surfacedAt: existing?.surfacedAt ?? now,
            mutedUntil,
          });
        }
        return Array.from(byKey.values()).sort(laneSort);
      });
    };

    socket.on("copilot.cues.updated", onCues);
    return () => {
      socket.off("copilot.cues.updated", onCues);
    };
  }, [conversationId, profile.sameKindCooldownMs]);

  // Reset when conversation changes.
  useEffect(() => {
    setCues([]);
    resolvedRef.current = new Set();
    prefixLastSurfaceRef.current = new Map();
    dismissCountRef.current = new Map();
    setFocusIdx(0);
  }, [conversationId]);

  // 1Hz ticker so decay bars + stale + cooldown re-render. The seed
  // before the interval fires keeps nowTick at 0 for one paint to avoid
  // hydration mismatch under static export.
  useEffect(() => {
    setNowTick(Date.now());
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ─── auto-expire (ignored outcome) ───────────────────────────
  useEffect(() => {
    setCues((prev) => {
      const now = nowTick;
      const expired = prev.filter((c) => new Date(c.expiresAt).getTime() <= now);
      if (expired.length === 0) return prev;
      for (const c of expired) {
        if (resolvedRef.current.has(c.dedupKey)) continue;
        resolvedRef.current.add(c.dedupKey);
        if (token) {
          void postCueOutcome(token, {
            cueId: c.id,
            conversationId: c.conversationId,
            cueKind: c.kind,
            cueText: c.text,
            dedupKey: c.dedupKey,
            outcome: "ignored",
          });
        }
      }
      return prev.filter((c) => new Date(c.expiresAt).getTime() > now);
    });
  }, [nowTick, token]);

  // Decay the dismiss-count map every 60s.
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = dismissCountRef.current;
      for (const k of Array.from(m.keys())) {
        const v = m.get(k)!;
        if (v <= 1) m.delete(k);
        else m.set(k, v - 1);
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ─── action handler ──────────────────────────────────────────
  const act = useCallback(
    (cue: InternalCue, outcome: CueOutcome) => {
      if (resolvedRef.current.has(cue.dedupKey)) return;
      resolvedRef.current.add(cue.dedupKey);
      setFlash({ key: cue.dedupKey, kind: outcome === "accepted" ? "accept" : "reject" });
      window.setTimeout(
        () => setFlash((f) => (f?.key === cue.dedupKey ? null : f)),
        outcome === "accepted" ? FLASH_MS : SHAKE_MS,
      );
      if (outcome === "rejected") {
        const p = prefix(cue.dedupKey);
        dismissCountRef.current.set(p, (dismissCountRef.current.get(p) ?? 0) + 1);
      }
      setCues((prev) => prev.filter((c) => c.dedupKey !== cue.dedupKey));
      if (token) {
        void postCueOutcome(token, {
          cueId: cue.id,
          conversationId: cue.conversationId,
          cueKind: cue.kind,
          cueText: cue.text,
          dedupKey: cue.dedupKey,
          outcome,
        });
      }
    },
    [token],
  );

  // ─── tier-aware filter + visible cap ─────────────────────────
  const lanesView = useMemo(() => {
    const filtered = cues.filter((c) => profile.visibleLanes.includes(c.lane));
    const visible = filtered.slice(0, profile.maxVisible);
    const queued = filtered.length - visible.length;
    const pulseCount = visible.filter((c) => c.lane === "pulse").length;
    const dim = pulseCount >= 2; // high-intensity moment
    return {
      pulse: visible.filter((c) => c.lane === "pulse"),
      direction: visible.filter((c) => c.lane === "direction"),
      strategy: visible.filter((c) => c.lane === "strategy"),
      queued,
      dim,
    };
  }, [cues, profile]);

  // ─── keyboard navigation ─────────────────────────────────────
  useEffect(() => {
    const flat = [...lanesView.pulse, ...lanesView.direction, ...lanesView.strategy];
    if (flat.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      // Only handle when nothing is being typed in.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(flat.length - 1, i + 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        const cue = flat[Math.min(focusIdx, flat.length - 1)];
        if (cue) {
          e.preventDefault();
          act(cue, "accepted");
        }
      } else if (e.key === "Escape") {
        const cue = flat[Math.min(focusIdx, flat.length - 1)];
        if (cue) {
          e.preventDefault();
          act(cue, "rejected");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lanesView, focusIdx, act]);

  // Clamp focus when the visible list shrinks.
  useEffect(() => {
    const total =
      lanesView.pulse.length + lanesView.direction.length + lanesView.strategy.length;
    if (focusIdx >= total) setFocusIdx(Math.max(0, total - 1));
  }, [lanesView, focusIdx]);

  const totalVisible =
    lanesView.pulse.length + lanesView.direction.length + lanesView.strategy.length;
  let lastAnyPrefixSurfaceAt = nowTick;
  if (prefixLastSurfaceRef.current.size > 0) {
    lastAnyPrefixSurfaceAt = 0;
    prefixLastSurfaceRef.current.forEach((v) => {
      if (v > lastAnyPrefixSurfaceAt) lastAnyPrefixSurfaceAt = v;
    });
  }
  const silent =
    !!conversationId &&
    totalVisible === 0 &&
    prefixLastSurfaceRef.current.size > 0 &&
    nowTick - lastAnyPrefixSurfaceAt > SILENCE_MS;

  // ─── render ──────────────────────────────────────────────────
  const hasCoaching = lanesView.direction.length + lanesView.strategy.length > 0;
  return (
    <div className="flex flex-col gap-3">
      {/* Pulse band - breaks out of the card chrome to be visually dominant.
          Pulse cues are time-critical signals (escalation risk, churn flags,
          customer says "cancel"). Bigger type, rose-100 fill, animated pulse
          dot - must register at a glance even when the agent's eye is on the
          transcript. */}
      {lanesView.pulse.length > 0 && (
        <div className="rounded-2xl bg-rose-50 ring-1 ring-rose-200 shadow-sm overflow-hidden">
          <div className="px-4 py-2 flex items-center gap-2 bg-rose-100/70 border-b border-rose-200">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-60 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
            </span>
            <span className="text-[11px] font-bold uppercase tracking-widest text-rose-700">
              {t("liveCopilot.cues.lanePulse")}
            </span>
            <span className="text-[11px] text-rose-700/70 tabular-nums">
              {lanesView.pulse.length}
            </span>
          </div>
          <ul className="px-3 py-2.5 space-y-2">
            {lanesView.pulse.map((c) => (
              <CueRow
                key={c.dedupKey}
                cue={c}
                tone="rose"
                profile={profile}
                now={nowTick}
                flash={flash?.key === c.dedupKey ? flash.kind : null}
                focused={keyAt(lanesView, focusIdx) === c.dedupKey}
                suppressedRecently={dismissCountRef.current.get(c.dedupKey.split(":")[0]) ?? 0}
                onAct={act}
                prominent
              />
            ))}
          </ul>
        </div>
      )}

      {/* Coaching card - Direction + Strategy lanes. Lower-urgency,
          longer-lived guidance. Same chrome as the rest of the rail. */}
      {(hasCoaching || lanesView.pulse.length === 0) && (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-50">
            <span className="text-violet-600">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M4 4h12v3H4V4zm0 5h12v3H4V9zm0 5h12v3H4v-3z" />
              </svg>
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
              Coaching
            </span>
            <TierSelector tier={profile.tier} onChange={setTier} />
            {hasCoaching && (
              <span className="text-[11px] text-gray-400 tabular-nums">
                {lanesView.direction.length + lanesView.strategy.length}
              </span>
            )}
            {lanesView.queued > 0 && (
              <span
                className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded-full bg-gray-100"
                title={t("liveCopilot.cues.queuedTitle")}
              >
                +{lanesView.queued}
              </span>
            )}
          </div>

          <div className="px-4 py-3 space-y-3">
            {!hasCoaching && lanesView.pulse.length === 0 ? (
              silent ? (
                <ListeningDot />
              ) : (
                <p className="text-[12px] text-gray-400 italic">{t("liveCopilot.cues.noCues")}</p>
              )
            ) : (
              <>
                <Lane
                  name={t("liveCopilot.cues.laneDirection")}
                  tone="amber"
                  cues={lanesView.direction}
                  profile={profile}
                  now={nowTick}
                  flash={flash}
                  focusKey={keyAt(lanesView, focusIdx)}
                  dismissCounts={dismissCountRef.current}
                  onAct={act}
                  dim={lanesView.dim}
                />
                <Lane
                  name={t("liveCopilot.cues.laneStrategy")}
                  tone="indigo"
                  cues={lanesView.strategy}
                  profile={profile}
                  now={nowTick}
                  flash={flash}
                  focusKey={keyAt(lanesView, focusIdx)}
                  dismissCounts={dismissCountRef.current}
                  onAct={act}
                  dim={lanesView.dim}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── sort + key helpers ─────────────────────────────────────────

const LANE_ORDER: Record<InternalCue["lane"], number> = { pulse: 0, direction: 1, strategy: 2 };
function laneSort(a: InternalCue, b: InternalCue): number {
  const l = LANE_ORDER[a.lane] - LANE_ORDER[b.lane];
  if (l !== 0) return l;
  return b.score - a.score;
}

function keyAt(view: { pulse: InternalCue[]; direction: InternalCue[]; strategy: InternalCue[] }, i: number): string | null {
  const flat = [...view.pulse, ...view.direction, ...view.strategy];
  return flat[Math.min(i, flat.length - 1)]?.dedupKey ?? null;
}

// ─── Tier selector ──────────────────────────────────────────────

function TierSelector({ tier, onChange }: { tier: CopilotTier; onChange: (t: CopilotTier) => void }) {
  const { t: translate } = useI18n();
  return (
    <div className="ml-auto flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
      {(["junior", "mid", "senior"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={clsx(
            "px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded transition",
            tier === opt ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
          )}
          title={
            opt === "junior"
              ? translate("liveCopilot.cues.tierJuniorDesc")
              : opt === "mid"
              ? translate("liveCopilot.cues.tierMidDesc")
              : translate("liveCopilot.cues.tierSeniorDesc")
          }
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ─── Lane ───────────────────────────────────────────────────────

type CueTone = "rose" | "amber" | "indigo";

interface LaneProps {
  name: string;
  tone: CueTone;
  cues: InternalCue[];
  profile: CopilotProfile;
  now: number;
  flash: { key: string; kind: "accept" | "reject" } | null;
  focusKey: string | null;
  dismissCounts: Map<string, number>;
  onAct: (cue: InternalCue, outcome: CueOutcome) => void;
  dim: boolean;
}

function Lane({ name, tone, cues, profile, now, flash, focusKey, dismissCounts, onAct, dim }: LaneProps) {
  if (cues.length === 0) return null;
  const labelTone: Record<CueTone, string> = {
    rose: "text-rose-600",
    amber: "text-amber-700",
    indigo: "text-indigo-600",
  };
  return (
    <div className={clsx("transition-opacity duration-300", dim && "opacity-55")}>
      <div className={clsx("text-[11px] font-semibold uppercase tracking-wider mb-1.5", labelTone[tone])}>{name}</div>
      <ul className="space-y-1.5">
        {cues.map((c) => (
          <CueRow
            key={c.dedupKey}
            cue={c}
            tone={tone}
            profile={profile}
            now={now}
            flash={flash?.key === c.dedupKey ? flash.kind : null}
            focused={focusKey === c.dedupKey}
            suppressedRecently={dismissCounts.get(c.dedupKey.split(":")[0]) ?? 0}
            onAct={onAct}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── CueRow ─────────────────────────────────────────────────────

interface CueRowProps {
  cue: InternalCue;
  tone: CueTone;
  profile: CopilotProfile;
  now: number;
  flash: "accept" | "reject" | null;
  focused: boolean;
  suppressedRecently: number;
  onAct: (cue: InternalCue, outcome: CueOutcome) => void;
  /** Pulse-band sizing: bigger text, taller row, taller decay bar. */
  prominent?: boolean;
}

function CueRow({ cue, tone, profile, now, flash, focused, suppressedRecently, onAct, prominent }: CueRowProps) {
  const { t } = useI18n();
  // Entrance animation: mounted false → true on next tick. Senior skips.
  const [entered, setEntered] = useState(!profile.animations);
  useEffect(() => {
    if (profile.animations) {
      const id = window.setTimeout(() => setEntered(true), 10);
      return () => window.clearTimeout(id);
    }
  }, [profile.animations]);

  const expiresMs = new Date(cue.expiresAt).getTime();
  const ttlMs = Math.max(1, expiresMs - cue.surfacedAt);
  const remainingMs = Math.max(0, expiresMs - now);
  const decayPct = Math.max(0, Math.min(100, (remainingMs / ttlMs) * 100));
  const ageMs = now - cue.surfacedAt;
  const stale = ageMs > profile.staleAfterMs;
  const muted = cue.mutedUntil > now;

  const bg: Record<CueTone, string> = {
    rose: "bg-white ring-rose-200",
    amber: "bg-amber-50/80 ring-amber-200",
    indigo: "bg-indigo-50/70 ring-indigo-200",
  };
  const acceptCls: Record<CueTone, string> = {
    rose: "bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-300",
    amber: "text-amber-800 hover:bg-amber-100 focus-visible:ring-amber-300",
    indigo: "text-indigo-700 hover:bg-indigo-100 focus-visible:ring-indigo-300",
  };
  const decayCls: Record<CueTone, string> = {
    rose: "bg-rose-400",
    amber: "bg-amber-400",
    indigo: "bg-indigo-400",
  };

  return (
    <li
      data-cue-key={cue.dedupKey}
      className={clsx(
        "relative flex items-center gap-2 rounded-lg ring-1 transition-all duration-200 ease-out",
        prominent ? "px-3 py-2.5" : "px-2.5 py-2",
        bg[tone],
        focused && "ring-2 ring-gray-400",
        flash === "accept" && "ring-2 ring-emerald-400",
        flash === "reject" && "animate-[cue-shake_180ms_ease-in-out]",
        stale && "opacity-60",
        muted && "opacity-50 grayscale-[40%]",
        profile.animations && !entered && "opacity-0 translate-x-1.5",
      )}
      title={`${cue.rationale}${muted ? "  ·  cooldown" : ""}${
        suppressedRecently > 0 ? `  ·  ${suppressedRecently}× dismissed recently` : ""
      }`}
    >
      <span
        className={clsx(
          "flex-1 leading-snug text-gray-900",
          prominent ? "text-[15px] font-medium" : "text-[13px]",
        )}
      >
        {cue.text}
      </span>

      {suppressedRecently > 0 && (
        <span
          className="text-[10px] font-mono text-gray-400 px-1 py-0.5 rounded bg-gray-100"
          title={`Dismissed ${suppressedRecently}× this minute`}
        >
          ×{suppressedRecently}
        </span>
      )}

      <button
        type="button"
        onClick={() => onAct(cue, "accepted")}
        className={clsx(
          "shrink-0 inline-flex items-center justify-center rounded-md transition focus:outline-none focus-visible:ring-2",
          prominent ? "w-9 h-9" : "w-8 h-8",
          acceptCls[tone],
        )}
        aria-label={t("liveCopilot.cues.acceptAria")}
        title={t("liveCopilot.cues.acceptAria")}
      >
        <svg className={prominent ? "w-4 h-4" : "w-3.5 h-3.5"} viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 010 1.4l-7.1 7.1a1 1 0 01-1.4 0L3.3 8.9a1 1 0 011.4-1.4L8.9 11.7l6.4-6.4a1 1 0 011.4 0z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onAct(cue, "rejected")}
        className={clsx(
          "shrink-0 inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 transition",
          prominent ? "w-9 h-9" : "w-8 h-8",
        )}
        aria-label={t("liveCopilot.cues.dismissAria")}
        title={t("liveCopilot.cues.notUseful")}
      >
        <svg className={prominent ? "w-3.5 h-3.5" : "w-3 h-3"} viewBox="0 0 20 20" fill="currentColor">
          <path d="M6.225 4.811a1 1 0 011.414 0L10 7.172l2.361-2.361a1 1 0 111.414 1.414L11.414 8.586l2.361 2.361a1 1 0 11-1.414 1.414L10 10l-2.361 2.361a1 1 0 11-1.414-1.414l2.361-2.361-2.361-2.361a1 1 0 010-1.414z" />
        </svg>
      </button>

      {/* decay bar - taller so it actually reads as a countdown */}
      <span
        className={clsx(
          "absolute left-0 bottom-0 rounded-bl-lg transition-all duration-1000 ease-linear",
          prominent ? "h-1" : "h-0.5",
          decayCls[tone],
          decayPct < 25 && "opacity-50",
        )}
        style={{ width: `${decayPct}%` }}
      />
    </li>
  );
}

// ─── Listening indicator ────────────────────────────────────────

function ListeningDot() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-gray-500">
      <span className="relative inline-flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-50 animate-ping" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-400" />
      </span>
      Listening…
    </div>
  );
}
