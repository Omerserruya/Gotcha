import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import {C} from './lib/colors';
import {springs} from './lib/spring';
import {DotGrid} from './components/DotGrid';

loadFont('normal', {weights: ['400', '600', '700', '900']});

// ───────────────────────────────────────────────────────────
// Scene 1 — HOOK (0–6s) — Pain roulette
// ───────────────────────────────────────────────────────────
const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const lines = [
    'Your customers are…',
    'discovering your brand',
    'asking questions',
    'waiting',
    'repeating themselves',
    'talking to bots',
    'getting transferred',
    'on calls',
    'being sold to',
    'leaving',
  ];
  const perLine = 14; // frames per line (~0.47s)
  const rouletteEnd = lines.length * perLine;

  // final beat starts after roulette
  const finalStart = rouletteEnd + 6;
  const finalOp = interpolate(
    frame,
    [finalStart, finalStart + 12, finalStart + 60, finalStart + 72],
    [0, 1, 1, 0.85],
    {extrapolateRight: 'clamp'}
  );

  const outOp = interpolate(frame, [170, 180], [1, 0], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: outOp}}>
      <DotGrid opacity={0.35} />
      <AbsoluteFill
        style={{alignItems: 'center', justifyContent: 'center'}}
      >
        {frame < finalStart ? (
          lines.map((line, i) => {
            const start = i * perLine;
            const op = interpolate(
              frame,
              [start, start + 4, start + perLine - 4, start + perLine],
              [0, 1, 1, 0],
              {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
            );
            const ty = interpolate(
              frame,
              [start, start + perLine],
              [10, -10]
            );
            if (op <= 0) return null;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  fontSize: 64,
                  fontWeight: 900,
                  letterSpacing: -1.5,
                  color: C.ink,
                  opacity: op,
                  transform: `translateY(${ty}px)`,
                }}
              >
                {line}
              </div>
            );
          })
        ) : (
          <div
            style={{
              fontSize: 52,
              fontWeight: 900,
              letterSpacing: -1.3,
              color: C.ink,
              textAlign: 'center',
              opacity: finalOp,
              maxWidth: 1100,
              lineHeight: 1.15,
            }}
          >
            And no one is in control of the communication.
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 2 — SHIFT (6–10s) — System emergence
// ───────────────────────────────────────────────────────────
const ShiftScene: React.FC = () => {
  const frame = useCurrentFrame();
  const bgMix = interpolate(frame, [0, 60], [0, 1], {extrapolateRight: 'clamp'});
  const bg = `rgb(${Math.round(248 - bgMix * 233)}, ${Math.round(
    249 - bgMix * 234
  )}, ${Math.round(255 - bgMix * 240)})`;

  const words = ['So', 'we', 'built', 'an', 'AI', 'OS', 'for', 'it.'];

  const zoom = interpolate(frame, [0, 120], [1, 0.96]);

  // subtle frame line
  const frameOp = interpolate(frame, [20, 50], [0, 1], {extrapolateRight: 'clamp'});

  const outOp = interpolate(frame, [110, 120], [1, 0], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: bg, opacity: outOp}}>
      {/* Thin glow frame */}
      <div
        style={{
          position: 'absolute',
          inset: 40,
          border: `1px solid rgba(129,140,248,${0.35 * frameOp})`,
          borderRadius: 14,
          boxShadow: `inset 0 0 80px rgba(129,140,248,${0.08 * frameOp})`,
        }}
      />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${zoom})`,
        }}
      >
        <div style={{display: 'flex', gap: 14}}>
          {words.map((w, i) => {
            const start = 30 + i * 6;
            const op = interpolate(frame, [start, start + 6], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            const highlight = w === 'AI' || w === 'OS';
            return (
              <span
                key={i}
                style={{
                  fontSize: 68,
                  fontWeight: 900,
                  letterSpacing: -2,
                  color: highlight ? C.indigo : bgMix > 0.5 ? '#F1F5F9' : C.ink,
                  opacity: op,
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 3 — AI CHAT (10–22s) — 12s = 360 frames
// ───────────────────────────────────────────────────────────
type MsgRole = 'user' | 'ai';
const ChatScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const msgs: {role: MsgRole; text: string; at: number; intent?: string}[] = [
    {role: 'user', text: 'Where is my order?', at: 10},
    {role: 'ai', text: 'Checking your order…', at: 40, intent: 'Support → Order status'},
    {role: 'ai', text: 'Order shipped. Arriving tomorrow.', at: 80},
    {role: 'user', text: 'I want to cancel it.', at: 160},
    {role: 'ai', text: 'Canceling order…', at: 195, intent: 'Support → Cancellation'},
    {role: 'ai', text: 'Order canceled. Refund initiated.', at: 235},
  ];

  const inOp = interpolate(frame, [0, 10], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [340, 360], [1, 0], {extrapolateRight: 'clamp'});

  // Action fly-out events
  const actions = [
    {label: 'ticket.opened', at: 95},
    {label: 'order.cancel', at: 250},
    {label: 'refund.initiated', at: 270},
  ];

  const currentIntent = [...msgs]
    .reverse()
    .find((m) => m.intent && frame >= m.at && frame < m.at + 50);

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: inOp * outOp}}>
      <DotGrid opacity={0.25} />

      {/* Chat window */}
      <div
        style={{
          position: 'absolute',
          left: 120,
          top: 70,
          width: 640,
          height: 580,
          background: '#FFFFFF',
          border: `0.5px solid ${C.border}`,
          borderRadius: 18,
          boxShadow: '0 8px 32px rgba(99,102,241,0.08)',
          padding: '24px 28px',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingBottom: 14,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: C.green,
              boxShadow: '0 0 0 3px rgba(16,185,129,0.2)',
            }}
          />
          <div style={{fontSize: 13, fontWeight: 700, color: C.ink}}>
            GOTCHA · Live Conversation
          </div>
        </div>

        <div style={{marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14}}>
          {msgs.map((m, i) => {
            const op = interpolate(frame, [m.at, m.at + 8], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            const scale = spring({
              frame: frame - m.at,
              fps,
              config: springs.pop,
              from: 0.96,
              to: 1,
            });
            if (op <= 0) return null;
            const isUser = m.role === 'user';
            return (
              <div
                key={i}
                style={{
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  maxWidth: '76%',
                  padding: '12px 18px',
                  borderRadius: isUser ? '20px 20px 6px 20px' : '20px 20px 20px 6px',
                  background: isUser ? C.indigo : '#F1F5F9',
                  color: isUser ? '#FFFFFF' : C.ink,
                  fontSize: 18,
                  fontWeight: 500,
                  opacity: op,
                  transform: `scale(${scale})`,
                  transformOrigin: isUser ? 'bottom right' : 'bottom left',
                  boxShadow: isUser
                    ? '0 4px 14px rgba(99,102,241,0.25)'
                    : '0 2px 8px rgba(15,23,42,0.04)',
                }}
              >
                {m.text}
              </div>
            );
          })}
        </div>
      </div>

      {/* Intent overlay */}
      {currentIntent && (() => {
        const op = interpolate(
          frame,
          [currentIntent.at, currentIntent.at + 8, currentIntent.at + 40, currentIntent.at + 50],
          [0, 1, 1, 0],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
        );
        return (
          <div
            style={{
              position: 'absolute',
              top: 80,
              right: 60,
              background: '#FFFFFF',
              border: `1px solid ${C.indigoPale}`,
              borderLeft: `3px solid ${C.indigo}`,
              borderRadius: 10,
              padding: '10px 16px',
              opacity: op,
              boxShadow: '0 4px 18px rgba(99,102,241,0.12)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: C.indigo,
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              Intent detected
            </div>
            <div style={{fontSize: 14, fontWeight: 600, color: C.ink, marginTop: 3}}>
              {currentIntent.intent}
            </div>
          </div>
        );
      })()}

      {/* Action trail — flies to invisible right panel */}
      <div
        style={{
          position: 'absolute',
          right: 60,
          top: 200,
          width: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {actions.map((a, i) => {
          const op = interpolate(frame, [a.at, a.at + 10], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const tx = interpolate(frame, [a.at, a.at + 18], [-120, 0]);
          if (op <= 0) return null;
          return (
            <div
              key={i}
              style={{
                background: '#FFFFFF',
                border: `1px solid ${C.border}`,
                borderLeft: `3px solid ${C.green}`,
                borderRadius: 10,
                padding: '10px 14px',
                opacity: op,
                transform: `translateX(${tx}px)`,
                fontSize: 13,
                fontWeight: 600,
                color: C.ink,
                boxShadow: '0 4px 14px rgba(16,185,129,0.08)',
              }}
            >
              <span style={{color: C.green, marginRight: 8}}>●</span>
              {a.label}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 4 — ACTION LAYER (22–32s) — 10s = 300 frames
// ───────────────────────────────────────────────────────────
const ActionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [280, 300], [1, 0], {extrapolateRight: 'clamp'});

  const events = [
    {label: 'Ticket created', detail: '#48291', color: C.indigo, at: 20},
    {label: 'Lead created', detail: 'david@acme.com', color: C.green, at: 55},
    {label: 'CRM status updated', detail: 'Interested', color: C.amber, at: 90},
    {label: 'Follow-up scheduled', detail: 'Tomorrow 10:00', color: C.indigoSoft, at: 125},
  ];

  const overlayOp = interpolate(
    frame,
    [170, 190, 260, 280],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  const overlayWords = ['Understands.', 'Decides.', 'Acts.'];

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: inOp * outOp}}>
      <DotGrid opacity={0.25} />

      {/* Left: residual chat ghost */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 120,
          width: 400,
          height: 440,
          background: '#FFFFFF',
          border: `0.5px solid ${C.border}`,
          borderRadius: 16,
          padding: 20,
          opacity: 0.55,
          boxShadow: '0 4px 24px rgba(15,23,42,0.04)',
        }}
      >
        <div style={{fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 1}}>
          CONVERSATION
        </div>
        <div
          style={{
            marginTop: 14,
            padding: '10px 14px',
            background: C.indigo,
            color: '#FFFFFF',
            borderRadius: '16px 16px 6px 16px',
            alignSelf: 'flex-end',
            maxWidth: '80%',
            fontSize: 14,
            marginLeft: 'auto',
            display: 'inline-block',
            float: 'right',
          }}
        >
          I'm interested in the Pro plan.
        </div>
        <div style={{clear: 'both'}} />
        <div
          style={{
            marginTop: 14,
            padding: '10px 14px',
            background: '#F1F5F9',
            color: C.ink,
            borderRadius: '16px 16px 16px 6px',
            maxWidth: '85%',
            fontSize: 14,
          }}
        >
          Great — I'll create a follow-up and notify sales.
        </div>
      </div>

      {/* Right: business state panel */}
      <div
        style={{
          position: 'absolute',
          right: 80,
          top: 110,
          width: 440,
          background: '#FFFFFF',
          border: `0.5px solid ${C.border}`,
          borderRadius: 18,
          padding: '22px 24px',
          boxShadow: '0 8px 36px rgba(99,102,241,0.10)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            paddingBottom: 12,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: C.indigo,
              boxShadow: '0 0 0 3px rgba(99,102,241,0.2)',
            }}
          />
          <div style={{fontSize: 12, fontWeight: 700, color: C.indigo, letterSpacing: 0.5}}>
            BUSINESS STATE · LIVE
          </div>
        </div>

        <div style={{marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10}}>
          {events.map((e, i) => {
            const op = interpolate(frame, [e.at, e.at + 12], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            const tx =
              spring({
                frame: frame - e.at,
                fps,
                config: springs.smooth,
                from: 1,
                to: 0,
              }) * 60;
            if (op <= 0) return null;
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  background: '#F8FAFC',
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  opacity: op,
                  transform: `translateX(${tx}px)`,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: e.color,
                    boxShadow: `0 0 0 3px ${e.color}25`,
                  }}
                />
                <div style={{flex: 1}}>
                  <div style={{fontSize: 14, fontWeight: 600, color: C.ink}}>{e.label}</div>
                  <div style={{fontSize: 12, color: C.secondary, marginTop: 2}}>
                    {e.detail}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: C.green,
                    letterSpacing: 1,
                  }}
                >
                  ✓
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Overlay verbs */}
      <div
        style={{
          position: 'absolute',
          bottom: 40,
          left: 0,
          right: 0,
          textAlign: 'center',
          opacity: overlayOp,
        }}
      >
        <div style={{display: 'inline-flex', gap: 24}}>
          {overlayWords.map((w, i) => (
            <span
              key={i}
              style={{
                fontSize: 34,
                fontWeight: 900,
                color: i === 2 ? C.indigo : C.ink,
                letterSpacing: -0.5,
              }}
            >
              {w}
            </span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 5 — LIVE COPILOT (32–44s) — 12s = 360 frames
// ───────────────────────────────────────────────────────────
const CopilotScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 14], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [340, 360], [1, 0], {extrapolateRight: 'clamp'});

  const thoughts = [
    'Customer is hesitant',
    'Suggest reassurance tone',
    'Offer discount option',
    'High intent detected',
    'Send suggested reply',
    'Update lead → Interested',
  ];

  const cards = [
    {label: 'Conversation summarized', detail: '3 topics · 6 messages', at: 220},
    {label: 'Next step', detail: 'Follow-up tomorrow', at: 250},
    {label: 'Opportunity', detail: 'Upsell detected', at: 280},
  ];

  return (
    <AbsoluteFill style={{background: '#0B1020', opacity: inOp * outOp}}>
      {/* Subtle grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(rgba(129,140,248,0.12) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
          opacity: 0.6,
        }}
      />
      {/* Soft glow */}
      <div
        style={{
          position: 'absolute',
          width: 720,
          height: 720,
          left: -160,
          top: -160,
          background:
            'radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 60%)',
        }}
      />

      {/* Left: copilot thought stream */}
      <div
        style={{
          position: 'absolute',
          left: 100,
          top: 120,
          width: 540,
          height: 480,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: C.indigoSoft,
            letterSpacing: 2,
            marginBottom: 20,
          }}
        >
          ● GOTCHA COPILOT · THINKING
        </div>
        {thoughts.map((t, i) => {
          const start = 20 + i * 22;
          const op = interpolate(
            frame,
            [start, start + 12, start + 90, start + 110],
            [0, 1, 1, 0.15],
            {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
          );
          const ty = interpolate(frame, [start, start + 20], [14, 0]);
          const blur = interpolate(frame, [start, start + 20], [6, 0]);
          return (
            <div
              key={i}
              style={{
                fontSize: 26,
                fontWeight: 500,
                color: '#E2E8F0',
                marginTop: 10,
                opacity: op,
                transform: `translateY(${ty}px)`,
                filter: `blur(${blur}px)`,
                letterSpacing: -0.3,
              }}
            >
              {t}
            </div>
          );
        })}
      </div>

      {/* Right: agent suggestion panel */}
      <div
        style={{
          position: 'absolute',
          right: 80,
          top: 120,
          width: 400,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(129,140,248,0.25)',
          borderRadius: 16,
          padding: 22,
          backdropFilter: 'blur(8px)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: C.indigoSoft,
            letterSpacing: 1.5,
          }}
        >
          AGENT · SUGGESTED REPLY
        </div>
        {(() => {
          const start = 140;
          const op = interpolate(frame, [start, start + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const text =
            'I understand your hesitation. I can offer you a 15% discount to get started risk-free.';
          const chars = Math.floor(
            interpolate(
              frame,
              [start + 10, start + 10 + text.length / 1.5],
              [0, text.length],
              {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
            )
          );
          return (
            <div
              style={{
                marginTop: 14,
                fontSize: 18,
                lineHeight: 1.5,
                color: '#F1F5F9',
                opacity: op,
                minHeight: 100,
              }}
            >
              {text.slice(0, chars)}
              {chars < text.length && (
                <span style={{color: C.indigoSoft}}>▎</span>
              )}
            </div>
          );
        })()}

        <div
          style={{
            marginTop: 16,
            display: 'flex',
            gap: 8,
            opacity: interpolate(frame, [200, 216], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          <div
            style={{
              background: C.indigo,
              color: '#FFFFFF',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Send (1-click)
          </div>
          <div
            style={{
              background: 'rgba(255,255,255,0.08)',
              color: '#CBD5E1',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Edit
          </div>
        </div>
      </div>

      {/* Summary cards bottom */}
      <div
        style={{
          position: 'absolute',
          bottom: 60,
          left: 100,
          right: 80,
          display: 'flex',
          gap: 16,
        }}
      >
        {cards.map((c, i) => {
          const op = interpolate(frame, [c.at, c.at + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const ty =
            spring({
              frame: frame - c.at,
              fps,
              config: springs.smooth,
              from: 1,
              to: 0,
            }) * 20;
          return (
            <div
              key={i}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(129,140,248,0.2)',
                borderRadius: 12,
                padding: '14px 18px',
                opacity: op,
                transform: `translateY(${ty}px)`,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: C.indigoSoft,
                  letterSpacing: 1,
                }}
              >
                {c.label.toUpperCase()}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: '#F1F5F9',
                  marginTop: 4,
                  fontWeight: 500,
                }}
              >
                {c.detail}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 6 — LIVE CALL (44–52s) — 8s = 240 frames
// ───────────────────────────────────────────────────────────
const CallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 14], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [220, 240], [1, 0], {extrapolateRight: 'clamp'});

  // Waveform bars
  const bars = Array.from({length: 40});

  const prompts = [
    {text: 'Customer tone: frustrated', color: C.red, at: 20},
    {text: 'Suggest empathy response', color: C.indigoSoft, at: 50},
    {text: 'Offer retention discount', color: C.amber, at: 85},
    {text: 'Wait — don\'t interrupt', color: C.green, at: 120},
  ];

  const buttons = [
    {label: 'Send suggestion', at: 155},
    {label: 'Adjust tone', at: 170},
    {label: 'Offer resolution', at: 185},
  ];

  return (
    <AbsoluteFill style={{background: '#0B1020', opacity: inOp * outOp}}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(rgba(129,140,248,0.1) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
          opacity: 0.5,
        }}
      />

      {/* Call UI header */}
      <div
        style={{
          position: 'absolute',
          top: 80,
          left: 0,
          right: 0,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: C.indigoSoft,
            letterSpacing: 2,
          }}
        >
          ● LIVE CALL · 02:47
        </div>
        <div
          style={{
            fontSize: 30,
            fontWeight: 700,
            color: '#F1F5F9',
            marginTop: 8,
            letterSpacing: -0.5,
          }}
        >
          David Cohen · Enterprise
        </div>
      </div>

      {/* Waveform */}
      <div
        style={{
          position: 'absolute',
          top: 220,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 6,
          height: 80,
        }}
      >
        {bars.map((_, i) => {
          const phase = (frame + i * 3) / 8;
          const h =
            22 + Math.abs(Math.sin(phase)) * 38 + Math.abs(Math.cos(phase * 0.7)) * 14;
          return (
            <div
              key={i}
              style={{
                width: 4,
                height: h,
                background: `rgba(129,140,248,${0.4 + Math.sin(phase) * 0.3})`,
                borderRadius: 2,
              }}
            />
          );
        })}
      </div>

      {/* AI prompts */}
      <div
        style={{
          position: 'absolute',
          top: 340,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {prompts.map((p, i) => {
          const op = interpolate(
            frame,
            [p.at, p.at + 12, p.at + 70, p.at + 90],
            [0, 1, 1, 0.2],
            {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
          );
          const ty = interpolate(frame, [p.at, p.at + 18], [10, 0]);
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px',
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${p.color}40`,
                borderLeft: `3px solid ${p.color}`,
                borderRadius: 10,
                opacity: op,
                transform: `translateY(${ty}px)`,
              }}
            >
              <span style={{color: p.color, fontSize: 11, fontWeight: 700}}>●</span>
              <span style={{color: '#E2E8F0', fontSize: 16, fontWeight: 500}}>
                {p.text}
              </span>
            </div>
          );
        })}
      </div>

      {/* Buttons */}
      <div
        style={{
          position: 'absolute',
          bottom: 60,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        {buttons.map((b, i) => {
          const s = spring({
            frame: frame - b.at,
            fps,
            config: springs.pop,
            from: 0.9,
            to: 1,
          });
          const op = interpolate(frame, [b.at, b.at + 10], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const primary = i === 0;
          return (
            <div
              key={i}
              style={{
                padding: '12px 20px',
                borderRadius: 10,
                background: primary ? C.indigo : 'rgba(255,255,255,0.06)',
                color: primary ? '#FFFFFF' : '#CBD5E1',
                fontSize: 13,
                fontWeight: 700,
                border: primary ? 'none' : '1px solid rgba(129,140,248,0.25)',
                opacity: op,
                transform: `scale(${s})`,
                boxShadow: primary ? '0 0 24px rgba(99,102,241,0.35)' : undefined,
              }}
            >
              {b.label}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 7 — COMMAND CENTER (52–58s) — 6s = 180 frames
// ───────────────────────────────────────────────────────────
const CommandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 14], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [160, 180], [1, 0], {extrapolateRight: 'clamp'});

  // Input slides from right, locks center
  const inputTX =
    spring({
      frame: frame - 10,
      fps,
      config: springs.smooth,
      from: 1,
      to: 0,
    }) * 300;
  const inputScale = spring({
    frame: frame - 10,
    fps,
    config: springs.smooth,
    from: 0.9,
    to: 1,
  });

  // Typing command
  const cmd1 = 'Create workflow for WhatsApp leads interested in product';
  const cmd2 = 'Send campaign to users inactive 3 months';

  const phase = frame < 90 ? 1 : 2;
  const text = phase === 1 ? cmd1 : cmd2;
  const typeStart = phase === 1 ? 30 : 95;
  const chars = Math.floor(
    interpolate(
      frame,
      [typeStart, typeStart + text.length / 1.8],
      [0, text.length],
      {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
    )
  );

  // Execution events
  const events = [
    {label: 'Audience built', at: 70},
    {label: 'Workflow activated', at: 85},
    {label: 'Broadcast triggered', at: 130},
  ];

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: inOp * outOp}}>
      <DotGrid opacity={0.3} />

      {/* Command input */}
      <div
        style={{
          position: 'absolute',
          top: 160,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          transform: `translateX(${inputTX}px) scale(${inputScale})`,
        }}
      >
        <div
          style={{
            width: 820,
            background: '#FFFFFF',
            border: `2px solid ${C.indigo}`,
            borderRadius: 14,
            padding: '22px 28px',
            boxShadow: '0 16px 48px rgba(99,102,241,0.18)',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: C.indigo,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            ⌘ Command Center
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 24,
              fontWeight: 600,
              color: C.ink,
              letterSpacing: -0.4,
              minHeight: 34,
            }}
          >
            {text.slice(0, chars)}
            <span
              style={{
                color: C.indigo,
                opacity: Math.floor(frame / 10) % 2 ? 1 : 0.3,
              }}
            >
              ▎
            </span>
          </div>
        </div>
      </div>

      {/* Execution pipeline — SVG flow */}
      <svg
        width={1000}
        height={160}
        style={{
          position: 'absolute',
          left: 140,
          top: 340,
        }}
      >
        {['CRM', 'Segment', 'Workflow', 'Broadcast'].map((label, i) => {
          const x = 60 + i * 280;
          const appear = 50 + i * 18;
          const op = interpolate(frame, [appear, appear + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <g key={i} opacity={op}>
              <circle
                cx={x}
                cy={80}
                r={14}
                fill="#FFFFFF"
                stroke={C.indigo}
                strokeWidth={2}
              />
              <circle cx={x} cy={80} r={5} fill={C.indigo} />
              <text
                x={x}
                y={118}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill={C.ink}
              >
                {label}
              </text>
              {i < 3 &&
                (() => {
                  const lineStart = appear + 8;
                  const progress = interpolate(
                    frame,
                    [lineStart, lineStart + 14],
                    [0, 260],
                    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
                  );
                  return (
                    <line
                      x1={x + 14}
                      y1={80}
                      x2={x + 14 + progress}
                      y2={80}
                      stroke={C.indigo}
                      strokeWidth={2}
                      strokeDasharray="4 4"
                    />
                  );
                })()}
            </g>
          );
        })}
      </svg>

      {/* Events */}
      <div
        style={{
          position: 'absolute',
          bottom: 50,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        {events.map((e, i) => {
          const op = interpolate(frame, [e.at, e.at + 12], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const ty = interpolate(frame, [e.at, e.at + 18], [12, 0]);
          return (
            <div
              key={i}
              style={{
                background: '#FFFFFF',
                border: `1px solid ${C.border}`,
                borderLeft: `3px solid ${C.green}`,
                borderRadius: 10,
                padding: '10px 16px',
                opacity: op,
                transform: `translateY(${ty}px)`,
                fontSize: 13,
                fontWeight: 600,
                color: C.ink,
                boxShadow: '0 4px 14px rgba(16,185,129,0.1)',
              }}
            >
              <span style={{color: C.green, marginRight: 8}}>✓</span>
              {e.label}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 8 — ENDING (58–60s) — 2s = 60 frames
// ───────────────────────────────────────────────────────────
const EndingScene: React.FC = () => {
  const frame = useCurrentFrame();

  const lines = [
    'Every conversation…',
    'before you sell…',
    'while you sell…',
    'after you sell…',
  ];

  return (
    <AbsoluteFill
      style={{
        background: C.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
      }}
    >
      {lines.map((l, i) => {
        const start = i * 6;
        const op = interpolate(frame, [start, start + 6], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <div
            key={i}
            style={{
              fontSize: 28,
              fontWeight: 500,
              color: C.secondary,
              letterSpacing: -0.3,
              opacity: op,
              marginTop: 6,
            }}
          >
            {l}
          </div>
        );
      })}

      <div
        style={{
          marginTop: 30,
          fontSize: 36,
          fontWeight: 900,
          color: C.ink,
          letterSpacing: -1,
          opacity: interpolate(frame, [36, 46], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        This is not customer support.
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 42,
          fontWeight: 900,
          color: C.indigo,
          letterSpacing: -1.2,
          opacity: interpolate(frame, [50, 60], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        This is Customer Communication OS.
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Composition root
// ───────────────────────────────────────────────────────────
export const LAUNCH_TOTAL = 1800; // 60s @ 30fps

export const GotchaLaunch: React.FC = () => {
  return (
    <AbsoluteFill style={{background: C.canvas, fontFamily: 'Inter'}}>
      <Sequence from={0} durationInFrames={180}>
        <HookScene />
      </Sequence>
      <Sequence from={180} durationInFrames={120}>
        <ShiftScene />
      </Sequence>
      <Sequence from={300} durationInFrames={360}>
        <ChatScene />
      </Sequence>
      <Sequence from={660} durationInFrames={300}>
        <ActionScene />
      </Sequence>
      <Sequence from={960} durationInFrames={360}>
        <CopilotScene />
      </Sequence>
      <Sequence from={1320} durationInFrames={240}>
        <CallScene />
      </Sequence>
      <Sequence from={1560} durationInFrames={180}>
        <CommandScene />
      </Sequence>
      <Sequence from={1740} durationInFrames={60}>
        <EndingScene />
      </Sequence>
    </AbsoluteFill>
  );
};
