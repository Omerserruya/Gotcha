"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { readReplay, type TimelineEvent } from "@/lib/cue-recorder";

/**
 * Post-call replay UI.
 *
 * Reads the timeline from localStorage (populated by useCueRecorder during
 * the live call) and lets the rep / manager scrub through:
 *   - transcript progression
 *   - frame transitions (version + stage + intent)
 *   - cue emissions (with state - shown / accepted / dismissed / ignored)
 *   - timing relative to call start
 *
 * No network calls. Pure client-side replay of buffered events.
 */

type CueOutcome = "accepted" | "rejected" | "ignored";

interface RecordedCue {
  id: string;
  dedupKey: string;
  lane: "pulse" | "direction" | "strategy";
  kind: string;
  text: string;
  rationale: string;
  expiresAt: string;
  surfacedAt: number;        // ms since t0 (derived)
  outcomeAt?: number;        // ms since t0
  outcome?: CueOutcome | "expired";
}

interface ReplayState {
  t0: number;
  durationMs: number;
  events: TimelineEvent[];
  cues: RecordedCue[];
  transcript: Array<{ t: number; speaker: string; text: string; isFinal: boolean }>;
  frames: Array<{ t: number; version: number; stage?: string; intent?: string }>;
}

export default function ReplayPage({ params }: { params: { sessionId: string } }) {
  const [state, setState] = useState<ReplayState | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  // Hydrate once on mount.
  useEffect(() => {
    const events = readReplay(params.sessionId);
    if (events.length === 0) return;
    setState(buildState(events));
  }, [params.sessionId]);

  // Playhead animation loop.
  useEffect(() => {
    if (!playing || !state) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      setPlayhead((p) => {
        const next = p + dt * speed;
        if (next >= state.durationMs) {
          setPlaying(false);
          return state.durationMs;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed, state]);

  if (!state) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm px-6 py-8 max-w-md text-center">
          <h1 className="text-base font-semibold text-gray-800">No replay available</h1>
          <p className="text-xs text-gray-500 mt-2">
            No recorded events for session <code className="font-mono">{params.sessionId}</code>.
            Replays are stored locally on the device the call was made from.
          </p>
        </div>
      </main>
    );
  }

  const visible = sliceAtPlayhead(state, playhead);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-4">
        <Header sessionId={params.sessionId} state={state} playhead={playhead} />

        <Scrubber
          state={state}
          playhead={playhead}
          onSeek={(ms) => {
            setPlaying(false);
            setPlayhead(ms);
          }}
        />

        <Controls
          playing={playing}
          speed={speed}
          onPlayPause={() => setPlaying((p) => !p)}
          onSpeed={setSpeed}
          onRestart={() => {
            setPlayhead(0);
            setPlaying(true);
          }}
        />

        <div className="grid grid-cols-12 gap-4">
          <section className="col-span-7 bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
            <Header2 title="Transcript" />
            <TranscriptPane lines={visible.transcript} />
          </section>

          <section className="col-span-5 bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
            <Header2 title="Cues" badge={visible.cues.length} />
            <CuesPane cues={visible.cues} playhead={playhead} />
          </section>
        </div>

        <EventList events={state.events} t0={state.t0} playhead={playhead} />
      </div>
    </main>
  );
}

// ─── derivation ─────────────────────────────────────────────────

function buildState(events: TimelineEvent[]): ReplayState {
  const t0 = events[0]?.t ?? Date.now();
  const last = events[events.length - 1]?.t ?? t0;
  const durationMs = Math.max(1, last - t0);

  const transcript: ReplayState["transcript"] = [];
  const frames: ReplayState["frames"] = [];
  const cueByKey = new Map<string, RecordedCue>();

  for (const ev of events) {
    const offset = ev.t - t0;
    if (ev.kind === "transcript") {
      const d = ev.data as { speaker?: string; text?: string; isFinal?: boolean };
      if (d?.text && d.speaker) {
        transcript.push({ t: offset, speaker: d.speaker, text: d.text, isFinal: !!d.isFinal });
      }
    } else if (ev.kind === "frame") {
      const f = (ev.data as any)?.frame;
      if (f?.version != null) {
        frames.push({
          t: offset,
          version: f.version,
          stage: f.stage?.name,
          intent: f.intent?.primary,
        });
      }
    } else if (ev.kind === "cues_emitted") {
      const cues = (ev.data as any)?.cues as RecordedCue[] | undefined;
      if (!cues) continue;
      for (const c of cues) {
        const existing = cueByKey.get(c.dedupKey);
        if (!existing) {
          cueByKey.set(c.dedupKey, { ...c, surfacedAt: offset });
        }
      }
    } else if (ev.kind === "cue_outcome") {
      const o = ev.data as { dedupKey?: string; outcome?: CueOutcome };
      if (!o?.dedupKey || !o.outcome) continue;
      const entry = cueByKey.get(o.dedupKey);
      if (entry) {
        entry.outcomeAt = offset;
        entry.outcome = o.outcome;
      }
    }
  }

  // Mark any un-resolved cues whose TTL elapsed before call end as expired.
  const collected: RecordedCue[] = [];
  cueByKey.forEach((c) => {
    if (!c.outcome) {
      const ttlMs = new Date(c.expiresAt).getTime() - (t0 + c.surfacedAt);
      if (c.surfacedAt + ttlMs < durationMs) {
        c.outcomeAt = c.surfacedAt + ttlMs;
        c.outcome = "expired";
      }
    }
    collected.push(c);
  });

  return {
    t0,
    durationMs,
    events,
    cues: collected.sort((a, b) => a.surfacedAt - b.surfacedAt),
    transcript,
    frames,
  };
}

function sliceAtPlayhead(state: ReplayState, playhead: number) {
  return {
    transcript: state.transcript.filter((l) => l.t <= playhead),
    cues: state.cues.filter((c) => c.surfacedAt <= playhead),
  };
}

// ─── sub-components ─────────────────────────────────────────────

function Header({ sessionId, state, playhead }: { sessionId: string; state: ReplayState; playhead: number }) {
  return (
    <header className="flex items-baseline justify-between">
      <div>
        <h1 className="text-base font-semibold text-gray-800">Call replay</h1>
        <p className="text-[11px] text-gray-500 font-mono mt-0.5">{sessionId}</p>
      </div>
      <div className="text-right">
        <div className="text-2xl font-light tabular-nums text-gray-900">
          {fmtMs(playhead)} <span className="text-gray-400 text-base">/ {fmtMs(state.durationMs)}</span>
        </div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {state.cues.length} cues · {state.frames.length} frames
        </div>
      </div>
    </header>
  );
}

function Header2({ title, badge }: { title: string; badge?: number }) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-50">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{title}</span>
      {badge != null && <span className="ml-auto text-[10px] text-gray-400">{badge}</span>}
    </div>
  );
}

function Scrubber({
  state,
  playhead,
  onSeek,
}: {
  state: ReplayState;
  playhead: number;
  onSeek: (ms: number) => void;
}) {
  return (
    <div className="relative bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm px-4 py-3">
      <div className="relative h-10">
        {/* track */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-gray-100 rounded-full" />

        {/* cue markers */}
        {state.cues.map((c) => (
          <button
            key={c.dedupKey + ":" + c.surfacedAt}
            type="button"
            onClick={() => onSeek(c.surfacedAt)}
            title={`${c.lane.toUpperCase()} · ${c.text} · ${fmtOutcome(c.outcome)}`}
            className={clsx(
              "absolute top-1/2 -translate-y-1/2 w-1.5 h-4 rounded-sm transition-transform hover:scale-y-150",
              c.lane === "pulse" && "bg-rose-400",
              c.lane === "direction" && "bg-amber-400",
              c.lane === "strategy" && "bg-slate-300",
              c.outcome === "accepted" && "ring-2 ring-emerald-300",
              c.outcome === "rejected" && "opacity-40",
              c.outcome === "ignored" && "opacity-50",
              c.outcome === "expired" && "opacity-30",
            )}
            style={{ left: `${(c.surfacedAt / state.durationMs) * 100}%` }}
          />
        ))}

        {/* frame markers */}
        {state.frames.map((f) => (
          <div
            key={"f:" + f.version}
            className="absolute bottom-0 w-px h-2 bg-violet-200"
            style={{ left: `${(f.t / state.durationMs) * 100}%` }}
            title={`v${f.version}${f.stage ? " · " + f.stage : ""}`}
          />
        ))}

        {/* playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-gray-900"
          style={{ left: `${(playhead / state.durationMs) * 100}%` }}
        />

        {/* invisible click-seek surface */}
        <input
          type="range"
          min={0}
          max={state.durationMs}
          step={50}
          value={Math.min(playhead, state.durationMs)}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label="Seek"
        />
      </div>

      <div className="flex items-center gap-4 text-[10px] text-gray-400 mt-1.5">
        <Legend dot="bg-rose-400" label="Pulse" />
        <Legend dot="bg-amber-400" label="Direction" />
        <Legend dot="bg-slate-300" label="Strategy" />
        <span className="text-gray-300">·</span>
        <Legend dot="ring-2 ring-emerald-300 bg-rose-400" label="Accepted" />
        <Legend dot="bg-rose-400 opacity-40" label="Dismissed" />
        <Legend dot="bg-rose-400 opacity-30" label="Expired" />
      </div>
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("inline-block w-2 h-2 rounded-sm", dot)} />
      {label}
    </span>
  );
}

function Controls({
  playing,
  speed,
  onPlayPause,
  onSpeed,
  onRestart,
}: {
  playing: boolean;
  speed: number;
  onPlayPause: () => void;
  onSpeed: (s: number) => void;
  onRestart: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onPlayPause}
        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition"
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button
        type="button"
        onClick={onRestart}
        className="px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ring-gray-200 hover:bg-gray-50 transition"
      >
        Restart
      </button>
      <div className="flex items-center gap-1 ml-auto">
        {[1, 2, 4].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeed(s)}
            className={clsx(
              "px-2 py-1 text-[11px] font-medium rounded-md transition",
              speed === s ? "bg-gray-900 text-white" : "ring-1 ring-gray-200 hover:bg-gray-50",
            )}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}

function TranscriptPane({ lines }: { lines: ReplayState["transcript"] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div ref={ref} className="px-4 py-3 max-h-[420px] overflow-y-auto space-y-1.5">
      {lines.length === 0 ? (
        <p className="text-[11px] italic text-gray-400">Press play to scrub through the call.</p>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={clsx(
              "text-[12px] leading-snug",
              l.speaker === "agent" ? "text-gray-700" : "text-gray-900",
              !l.isFinal && "italic opacity-60",
            )}
          >
            <span
              className={clsx(
                "inline-block text-[9px] uppercase tracking-wider mr-2 align-middle px-1 py-0.5 rounded",
                l.speaker === "agent" ? "bg-violet-50 text-violet-600" : "bg-gray-100 text-gray-500",
              )}
            >
              {l.speaker}
            </span>
            {l.text}
          </div>
        ))
      )}
    </div>
  );
}

function CuesPane({ cues, playhead }: { cues: RecordedCue[]; playhead: number }) {
  if (cues.length === 0) {
    return <div className="px-4 py-3 text-[11px] italic text-gray-400">No cues yet.</div>;
  }
  return (
    <ul className="px-4 py-3 space-y-1.5 max-h-[420px] overflow-y-auto">
      {cues.slice().reverse().map((c) => {
        const resolved = c.outcome && c.outcomeAt != null && c.outcomeAt <= playhead;
        return (
          <li
            key={c.dedupKey + ":" + c.surfacedAt}
            className={clsx(
              "rounded-lg px-2.5 py-1.5 ring-1 transition-opacity",
              c.lane === "pulse" && "bg-rose-50/70 ring-rose-100",
              c.lane === "direction" && "bg-amber-50/70 ring-amber-100",
              c.lane === "strategy" && "bg-slate-50/70 ring-slate-100",
              resolved && c.outcome === "accepted" && "ring-emerald-300",
              resolved && c.outcome === "rejected" && "opacity-40 line-through",
              resolved && c.outcome === "ignored" && "opacity-50",
              resolved && c.outcome === "expired" && "opacity-30",
            )}
            title={c.rationale}
          >
            <div className="flex items-center gap-2">
              <span className="text-[9px] uppercase tracking-wider text-gray-500">{c.lane}</span>
              <span className="text-[12px] text-gray-800 flex-1 truncate">{c.text}</span>
              <span className="text-[10px] text-gray-400 font-mono tabular-nums">
                {fmtMs(c.surfacedAt)}
              </span>
            </div>
            {resolved && (
              <div className="text-[10px] text-gray-500 mt-0.5">
                {fmtOutcome(c.outcome)} at {fmtMs(c.outcomeAt!)} (+{fmtMs(c.outcomeAt! - c.surfacedAt)})
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EventList({
  events,
  t0,
  playhead,
}: {
  events: TimelineEvent[];
  t0: number;
  playhead: number;
}) {
  return (
    <details className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm">
      <summary className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-gray-600 cursor-pointer select-none">
        Raw event log ({events.length})
      </summary>
      <ul className="px-4 py-2 max-h-[300px] overflow-y-auto space-y-0.5 font-mono text-[10px]">
        {events.map((ev, i) => {
          const offset = ev.t - t0;
          const passed = offset <= playhead;
          return (
            <li
              key={i}
              className={clsx(
                "flex gap-3 leading-snug",
                passed ? "text-gray-700" : "text-gray-300",
              )}
            >
              <span className="text-gray-400 tabular-nums w-14 shrink-0">{fmtMs(offset)}</span>
              <span className="w-24 shrink-0 text-violet-600">{ev.kind}</span>
              <span className="truncate">{summarize(ev)}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ─── formatters ─────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtOutcome(o?: RecordedCue["outcome"]): string {
  if (!o) return "live";
  return o[0].toUpperCase() + o.slice(1);
}

function summarize(ev: TimelineEvent): string {
  switch (ev.kind) {
    case "transcript": {
      const d = ev.data as { speaker?: string; text?: string; isFinal?: boolean };
      return `${d?.speaker || "?"}: ${(d?.text || "").slice(0, 80)}${d?.isFinal ? "" : " …"}`;
    }
    case "frame": {
      const f = (ev.data as any)?.frame;
      return `v${f?.version ?? "?"} stage=${f?.stage?.name ?? "-"} intent=${f?.intent?.primary ?? "-"}`;
    }
    case "cues_emitted": {
      const cues = (ev.data as any)?.cues || [];
      return `${cues.length} cue(s): ${cues.map((c: any) => c.text).slice(0, 3).join(" · ")}`;
    }
    case "cue_outcome": {
      const o = ev.data as any;
      return `${o?.outcome} ${o?.cueText || o?.dedupKey || ""}`;
    }
    default:
      return "";
  }
}
