"use client";

/**
 * Living orb for the Command Center. Pure CSS/SVG — no external deps.
 *
 * States map to the modal's glow state:
 *   idle      — soft indigo/violet breathing, slow
 *   thinking  — faster multi-hue pulse, subtle spin
 *   ready     — emerald glow
 *   approval  — amber glow
 *   error     — rose glow
 *
 * Size is fixed at 40px so it sits flush with the modal's single-line input.
 */
import { CSSProperties } from "react";

export type OrbState = "idle" | "thinking" | "ready" | "approval" | "error";

interface Props {
  state: OrbState;
  size?: number;
}

const PALETTE: Record<OrbState, { a: string; b: string; c: string }> = {
  idle:     { a: "#6366f1", b: "#8b5cf6", c: "#a78bfa" }, // indigo → violet
  thinking: { a: "#38bdf8", b: "#818cf8", c: "#f472b6" }, // sky → indigo → pink
  ready:    { a: "#34d399", b: "#10b981", c: "#6ee7b7" }, // emerald
  approval: { a: "#fbbf24", b: "#f59e0b", c: "#fcd34d" }, // amber
  error:    { a: "#fb7185", b: "#ef4444", c: "#fca5a5" }, // rose
};

export default function SiriAvatar({ state, size = 40 }: Props) {
  const p = PALETTE[state];
  const breatheDur = state === "thinking" ? "1.2s" : "3.4s";
  const spinDur = state === "thinking" ? "4s" : "14s";
  const pulseDur = state === "thinking" ? "0.9s" : "2.6s";

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    position: "relative",
    flexShrink: 0,
    ["--orb-a" as any]: p.a,
    ["--orb-b" as any]: p.b,
    ["--orb-c" as any]: p.c,
    ["--orb-breathe" as any]: breatheDur,
    ["--orb-spin" as any]: spinDur,
    ["--orb-pulse" as any]: pulseDur,
  };

  return (
    <div style={containerStyle} aria-hidden>
      <style>{`
        @keyframes orbBreathe {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.08); }
        }
        @keyframes orbSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes orbPulseRing {
          0%   { opacity: 0.55; transform: scale(0.85); }
          70%  { opacity: 0;    transform: scale(1.35); }
          100% { opacity: 0;    transform: scale(1.4);  }
        }
        @keyframes orbShimmer {
          0%, 100% { opacity: 0.35; }
          50%      { opacity: 0.85; }
        }
        .orb-wrap {
          width: 100%; height: 100%;
          border-radius: 50%;
          position: relative;
          animation: orbBreathe var(--orb-breathe) ease-in-out infinite;
        }
        .orb-ring {
          position: absolute; inset: -2px;
          border-radius: 50%;
          border: 1px solid var(--orb-a);
          opacity: 0.5;
          animation: orbPulseRing var(--orb-pulse) ease-out infinite;
        }
        .orb-core {
          position: absolute; inset: 0;
          border-radius: 50%;
          background:
            radial-gradient(circle at 32% 28%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 32%),
            radial-gradient(circle at 68% 70%, var(--orb-c) 0%, rgba(0,0,0,0) 55%),
            conic-gradient(from 0deg,
              var(--orb-a),
              var(--orb-b),
              var(--orb-c),
              var(--orb-a));
          box-shadow:
            0 0 0 1px rgba(255,255,255,0.6) inset,
            0 0 12px 2px var(--orb-b),
            0 2px 14px -2px var(--orb-a);
          animation: orbSpin var(--orb-spin) linear infinite;
        }
        .orb-highlight {
          position: absolute;
          top: 14%; left: 22%;
          width: 34%; height: 28%;
          border-radius: 50%;
          background: radial-gradient(ellipse at center, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0) 70%);
          animation: orbShimmer var(--orb-breathe) ease-in-out infinite;
          pointer-events: none;
        }
      `}</style>
      <div className="orb-wrap">
        <div className="orb-ring" />
        <div className="orb-core" />
        <div className="orb-highlight" />
      </div>
    </div>
  );
}
