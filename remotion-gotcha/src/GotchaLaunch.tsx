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

loadFont('normal', {weights: ['400', '500', '600', '700', '900']});

// ───────────────────────────────────────────────────────────
// Scene 1 - HOOK (0–6s) - Pain roulette
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
  const perLine = 14;
  const rouletteEnd = lines.length * perLine;
  const finalStart = rouletteEnd + 6;

  const finalOp = interpolate(
    frame,
    [finalStart, finalStart + 12, finalStart + 60, finalStart + 72],
    [0, 1, 1, 0.85],
    {extrapolateRight: 'clamp'}
  );

  // Fade to BLACK (not canvas) to avoid gray composite with next scene
  const outOp = interpolate(frame, [160, 180], [1, 0], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: '#000000'}}>
      <AbsoluteFill style={{background: C.canvas, opacity: outOp}}>
        <DotGrid opacity={0.35} />
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          {frame < finalStart ? (
            lines.map((line, i) => {
              const start = i * perLine;
              const op = interpolate(
                frame,
                [start, start + 4, start + perLine - 4, start + perLine],
                [0, 1, 1, 0],
                {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
              );
              const ty = interpolate(frame, [start, start + perLine], [10, -10]);
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
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 2 - SHIFT (6–10s) - Pure dark, no gray midpoint
// ───────────────────────────────────────────────────────────
const ShiftScene: React.FC = () => {
  const frame = useCurrentFrame();
  const words = ['So', 'we', 'built', 'an', 'AI', 'OS', 'for', 'it.'];
  const zoom = interpolate(frame, [0, 120], [1, 0.97]);
  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const frameOp = interpolate(frame, [20, 50], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [105, 120], [1, 0], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: '#000000'}}>
      <AbsoluteFill style={{background: '#0B1020', opacity: inOp * outOp}}>
        <div
          style={{
            position: 'absolute',
            inset: 40,
            border: `1px solid rgba(129,140,248,${0.35 * frameOp})`,
            borderRadius: 14,
            boxShadow: `inset 0 0 80px rgba(129,140,248,${0.1 * frameOp})`,
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
              const start = 25 + i * 6;
              const op = interpolate(frame, [start, start + 8], [0, 1], {
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
                    color: highlight ? C.indigoSoft : '#F1F5F9',
                    opacity: op,
                    textShadow: highlight ? '0 0 24px rgba(129,140,248,0.4)' : undefined,
                  }}
                >
                  {w}
                </span>
              );
            })}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 3 - AI CHAT (10–24s) - 420f - centered card + resolution beat
// ───────────────────────────────────────────────────────────
type MsgRole = 'user' | 'ai';
const ChatScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const msgs: {role: MsgRole; text: string; at: number; intent?: string}[] = [
    {role: 'user', text: 'Where is my order?', at: 12},
    {role: 'ai', text: 'Checking your order…', at: 44, intent: 'Support → Order status'},
    {role: 'ai', text: 'Order shipped. Arriving tomorrow.', at: 88},
    {role: 'user', text: 'I want to cancel it.', at: 160},
    {role: 'ai', text: 'Canceling order…', at: 196, intent: 'Support → Cancellation'},
    {role: 'ai', text: 'Order canceled. Refund initiated.', at: 240},
  ];

  const resolveStart = 285;
  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [405, 420], [1, 0], {extrapolateRight: 'clamp'});

  // Active intent - latest matching msg whose intent is active
  const activeIntent = [...msgs]
    .reverse()
    .find((m) => m.intent && frame >= m.at && frame < m.at + 70);
  const intentKey = activeIntent?.intent ?? '';
  const intentAt = activeIntent?.at ?? 0;
  const intentOp = activeIntent
    ? interpolate(
        frame,
        [intentAt, intentAt + 10, intentAt + 55, intentAt + 70],
        [0, 1, 1, 0],
        {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
      )
    : 0;

  // Resolution pill fade-in & scene dim
  const dim = interpolate(frame, [resolveStart, resolveStart + 15], [1, 0.15], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const pillScale = spring({
    frame: frame - resolveStart,
    fps,
    config: springs.impact,
    from: 0.7,
    to: 1,
  });
  const pillOp = interpolate(frame, [resolveStart, resolveStart + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: inOp * outOp}}>
      <DotGrid opacity={0.22} />

      {/* Centered chat card */}
      <div
        style={{
          position: 'absolute',
          left: 320,
          top: 70,
          width: 640,
          minHeight: 480,
          background: '#FFFFFF',
          border: `0.5px solid ${C.border}`,
          borderRadius: 18,
          boxShadow: '0 12px 40px rgba(15,23,42,0.08)',
          padding: '24px 28px',
          opacity: dim,
        }}
      >
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
            const op = interpolate(frame, [m.at, m.at + 10], [0, 1], {
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
                  maxWidth: '78%',
                  padding: '13px 20px',
                  borderRadius: isUser ? '20px 20px 6px 20px' : '20px 20px 20px 6px',
                  background: isUser ? C.indigo : '#E0E7FF',
                  color: isUser ? '#FFFFFF' : '#3730A3',
                  fontSize: 19,
                  fontWeight: 500,
                  opacity: op,
                  transform: `scale(${scale})`,
                  transformOrigin: isUser ? 'bottom right' : 'bottom left',
                  boxShadow: isUser
                    ? '0 4px 14px rgba(99,102,241,0.28)'
                    : '0 2px 10px rgba(99,102,241,0.08)',
                }}
              >
                {m.text}
              </div>
            );
          })}
        </div>
      </div>

      {/* Intent badge - BELOW card, centered, large */}
      {intentOp > 0.01 && (
        <div
          key={intentKey}
          style={{
            position: 'absolute',
            top: 590,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: intentOp * dim,
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 20px',
              background: 'rgba(99,102,241,0.12)',
              borderRadius: 99,
              color: C.indigo,
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: 0.3,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: C.indigo,
                display: 'inline-block',
                boxShadow: '0 0 0 3px rgba(99,102,241,0.22)',
              }}
            />
            Intent detected: {intentKey}
          </div>
        </div>
      )}

      {/* Resolution pill - climax beat */}
      {frame >= resolveStart && (
        <AbsoluteFill
          style={{alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'}}
        >
          <div
            style={{
              padding: '16px 36px',
              background: 'linear-gradient(135deg, #10B981, #059669)',
              color: '#FFFFFF',
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 1,
              borderRadius: 30,
              transform: `scale(${pillScale})`,
              opacity: pillOp,
              boxShadow:
                '0 0 0 1px rgba(16,185,129,0.4), 0 0 42px 8px rgba(16,185,129,0.28)',
            }}
          >
            ✓  Resolved
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 4 - BRIDGE (24–28s) - "Every message is an opportunity."
// ───────────────────────────────────────────────────────────
const BridgeSlide: React.FC = () => {
  const frame = useCurrentFrame();
  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [108, 120], [1, 0], {extrapolateRight: 'clamp'});

  const line1Words = 'Every message'.split(' ');
  const line2Op = interpolate(frame, [40, 56], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: C.canvas,
        opacity: inOp * outOp,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
      }}
    >
      <DotGrid opacity={0.22} />
      <div style={{display: 'flex', gap: 16}}>
        {line1Words.map((w, i) => {
          const start = 6 + i * 8;
          const op = interpolate(frame, [start, start + 12], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const ty = interpolate(frame, [start, start + 16], [18, 0]);
          return (
            <span
              key={i}
              style={{
                fontSize: 64,
                fontWeight: 900,
                letterSpacing: -1.5,
                color: C.ink,
                opacity: op,
                transform: `translateY(${ty}px)`,
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 18,
          fontSize: 44,
          fontWeight: 400,
          fontStyle: 'italic',
          color: C.indigo,
          opacity: line2Op,
          letterSpacing: -0.5,
        }}
      >
        is an opportunity.
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 5 - ACTION LAYER (Demo 2)
// ───────────────────────────────────────────────────────────
const ActionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [285, 300], [1, 0], {extrapolateRight: 'clamp'});

  const events = [
    {label: 'Ticket created', detail: '#48291', color: C.indigo, at: 25},
    {label: 'Lead created', detail: 'david@acme.com', color: C.green, at: 60},
    {label: 'CRM status updated', detail: 'Interested', color: C.amber, at: 95},
    {label: 'Follow-up scheduled', detail: 'Tomorrow 10:00', color: C.indigoSoft, at: 130},
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
      <DotGrid opacity={0.22} />

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
            background: '#E0E7FF',
            color: '#3730A3',
            borderRadius: '16px 16px 16px 6px',
            maxWidth: '85%',
            fontSize: 14,
          }}
        >
          Great - I'll create a follow-up and notify sales.
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
            const op = interpolate(frame, [e.at, e.at + 14], [0, 1], {
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
                fontSize: 36,
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
// Scene 6 - LIVE COPILOT - label pinned, bigger text, bigger cards
// ───────────────────────────────────────────────────────────
const CopilotScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [345, 360], [1, 0], {extrapolateRight: 'clamp'});

  const thoughts = [
    'Customer is hesitant',
    'Suggest reassurance tone',
    'Offer discount option',
    'High intent detected',
    'Send suggested reply',
    'Update lead → Interested',
  ];

  const cards = [
    {label: 'CONVERSATION SUMMARIZED', detail: '3 topics · 6 messages', at: 225},
    {label: 'NEXT STEP', detail: 'Follow-up tomorrow 10:00', at: 240},
    {label: 'OPPORTUNITY', detail: 'Upsell detected - Pro plan', at: 255},
  ];

  return (
    <AbsoluteFill style={{background: '#0B1020', opacity: inOp * outOp}}>
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

      {/* PINNED LABEL - scene root, never moves */}
      <div
        style={{
          position: 'absolute',
          top: 48,
          left: 64,
          fontSize: 11,
          fontWeight: 700,
          color: C.indigoSoft,
          letterSpacing: 2,
        }}
      >
        ● GOTCHA COPILOT · THINKING
      </div>

      {/* LEFT: thinking stream - larger text */}
      <div
        style={{
          position: 'absolute',
          left: 64,
          top: 110,
          width: 560,
        }}
      >
        {thoughts.map((t, i) => {
          const start = 10 + i * 18;
          const appearOp = interpolate(frame, [start, start + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          // Active = the most recent appeared
          const isLatest = i === Math.min(thoughts.length - 1, Math.floor((frame - 10) / 18));
          const baseColor = isLatest ? '#FFFFFF' : 'rgba(226,232,240,0.35)';
          const ty = interpolate(frame, [start, start + 20], [16, 0]);
          const blur = interpolate(frame, [start, start + 20], [6, 0]);
          return (
            <div
              key={i}
              style={{
                fontSize: 40,
                fontWeight: 500,
                color: baseColor,
                marginTop: 14,
                opacity: appearOp,
                transform: `translateY(${ty}px)`,
                filter: `blur(${blur}px)`,
                letterSpacing: -0.4,
                lineHeight: 1.25,
              }}
            >
              {t}
            </div>
          );
        })}
      </div>

      {/* RIGHT: agent suggestion card */}
      <div
        style={{
          position: 'absolute',
          right: 60,
          top: 110,
          width: 560,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(129,140,248,0.25)',
          borderRadius: 16,
          padding: 24,
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
                fontSize: 20,
                lineHeight: 1.5,
                color: '#F1F5F9',
                opacity: op,
                minHeight: 120,
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
            gap: 10,
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
              padding: '10px 16px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Send (1-click)
          </div>
          <div
            style={{
              background: 'rgba(255,255,255,0.08)',
              color: '#CBD5E1',
              padding: '10px 16px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Edit
          </div>
        </div>
      </div>

      {/* Bottom summary cards - larger */}
      <div
        style={{
          position: 'absolute',
          bottom: 60,
          left: 60,
          right: 60,
          display: 'flex',
          gap: 20,
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
            }) * 30;
          return (
            <div
              key={i}
              style={{
                flex: 1,
                minHeight: 90,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(129,140,248,0.28)',
                borderRadius: 14,
                padding: '16px 20px',
                opacity: op,
                transform: `translateY(${ty}px)`,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: C.indigoSoft,
                  letterSpacing: 1.5,
                }}
              >
                {c.label}
              </div>
              <div
                style={{
                  fontSize: 18,
                  color: '#FFFFFF',
                  marginTop: 8,
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
// Scene 7 - LIVE CALL INTRO - 3s setup
// ───────────────────────────────────────────────────────────
const LiveCallIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [82, 90], [1, 0], {extrapolateRight: 'clamp'});
  const words = 'Even on a call.'.split(' ');
  const line2Op = interpolate(frame, [50, 68], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: '#0D0D1A',
        opacity: inOp * outOp,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
      }}
    >
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
      <div style={{display: 'flex', gap: 16}}>
        {words.map((w, i) => {
          const start = 8 + i * 8;
          const op = interpolate(frame, [start, start + 12], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const ty = interpolate(frame, [start, start + 16], [16, 0]);
          return (
            <span
              key={i}
              style={{
                fontSize: 60,
                fontWeight: 900,
                color: '#FFFFFF',
                letterSpacing: -1.4,
                opacity: op,
                transform: `translateY(${ty}px)`,
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 16,
          fontSize: 30,
          fontStyle: 'italic',
          fontWeight: 400,
          color: C.indigoSoft,
          opacity: line2Op,
        }}
      >
        GOTCHA is listening.
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 8 - LIVE CALL (untouched core)
// ───────────────────────────────────────────────────────────
const CallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [225, 240], [1, 0], {extrapolateRight: 'clamp'});

  const bars = Array.from({length: 40});
  const prompts = [
    {text: 'Customer tone: frustrated', color: C.red, at: 20},
    {text: 'Suggest empathy response', color: C.indigoSoft, at: 50},
    {text: 'Offer retention discount', color: C.amber, at: 85},
    {text: 'Wait - don\'t interrupt', color: C.green, at: 120},
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
// Scene 9 - COMMAND CENTER - 300f, paced with drama
// ───────────────────────────────────────────────────────────
const CommandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const outOp = interpolate(frame, [285, 300], [1, 0], {extrapolateRight: 'clamp'});

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

  const cmd1 = 'Create workflow for WhatsApp leads interested in product';
  const cmd2 = 'Send campaign to users inactive 3 months';

  // Phase 1: type cmd1 30→120, execute 120→170
  // Phase 2: type cmd2 170→240, execute 240→290
  const phase = frame < 160 ? 1 : 2;
  const text = phase === 1 ? cmd1 : cmd2;
  const typeStart = phase === 1 ? 30 : 170;
  const chars = Math.floor(
    interpolate(
      frame,
      [typeStart, typeStart + text.length * 1.2],
      [0, text.length],
      {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
    )
  );

  // Pipeline dots: activate with staggered 25f after cmd1 typed
  const pipelineStart = 120;
  const pipelineLabels = ['CRM', 'Segment', 'Workflow', 'Broadcast'];

  // Execution events - staggered 30f
  const events = [
    {label: 'Audience built', at: 185},
    {label: 'Workflow activated', at: 215},
    {label: 'Broadcast triggered', at: 245},
  ];

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: inOp * outOp}}>
      <DotGrid opacity={0.28} />

      <div
        style={{
          position: 'absolute',
          top: 140,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          transform: `translateX(${inputTX}px) scale(${inputScale})`,
        }}
      >
        <div
          style={{
            width: 860,
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

      {/* Pipeline */}
      <svg
        width={1100}
        height={160}
        style={{position: 'absolute', left: 90, top: 310}}
      >
        {pipelineLabels.map((label, i) => {
          const x = 80 + i * 320;
          const activate = pipelineStart + i * 25;
          const dotOp = interpolate(frame, [activate, activate + 14], [0.4, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const dotScale = spring({
            frame: frame - activate,
            fps,
            config: springs.impact,
            from: 0.8,
            to: 1.1,
          });
          const active = frame >= activate;
          return (
            <g key={i}>
              {/* Line to next dot */}
              {i < pipelineLabels.length - 1 &&
                (() => {
                  const lineStart = activate + 8;
                  const progress = interpolate(
                    frame,
                    [lineStart, lineStart + 20],
                    [0, 300],
                    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
                  );
                  return (
                    <line
                      x1={x + 16}
                      y1={80}
                      x2={x + 16 + progress}
                      y2={80}
                      stroke={C.indigo}
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      opacity={0.8}
                    />
                  );
                })()}
              <circle
                cx={x}
                cy={80}
                r={16}
                fill={active ? '#FFFFFF' : 'transparent'}
                stroke={C.indigo}
                strokeWidth={2}
                opacity={dotOp}
                style={{
                  transformOrigin: `${x}px 80px`,
                  transform: `scale(${active ? dotScale : 1})`,
                }}
              />
              {active && (
                <circle cx={x} cy={80} r={6} fill={C.indigo} opacity={dotOp} />
              )}
              <text
                x={x}
                y={120}
                textAnchor="middle"
                fontSize={14}
                fontWeight={700}
                fill={active ? C.ink : C.muted}
                opacity={dotOp}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      <div
        style={{
          position: 'absolute',
          bottom: 60,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        {events.map((e, i) => {
          const op = interpolate(frame, [e.at, e.at + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const tx = interpolate(frame, [e.at, e.at + 20], [-20, 0]);
          return (
            <div
              key={i}
              style={{
                background: 'rgba(16,185,129,0.1)',
                border: '1px solid #10B981',
                borderRadius: 10,
                padding: '10px 18px',
                opacity: op,
                transform: `translateX(${tx}px)`,
                fontSize: 14,
                fontWeight: 700,
                color: '#10B981',
              }}
            >
              ✓ {e.label}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Scene 10 - OUTRO - 180f, 3 phases, logo reveal
// ───────────────────────────────────────────────────────────
const EndingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Phase 1: 0–90 copy lands
  // Phase 2: 90–150 logo reveal (dim lines, logo in)
  // Phase 3: 150–180 hold

  const lines = [
    {text: 'Every conversation…', size: 52, weight: 900, color: C.ink, at: 0},
    {text: 'before you sell…', size: 36, weight: 400, color: C.secondary, at: 18},
    {text: 'while you sell…', size: 36, weight: 400, color: C.secondary, at: 36},
    {text: 'after you sell…', size: 36, weight: 700, color: C.indigo, at: 54},
  ];

  const dimStart = 90;
  const lineDim = interpolate(frame, [dimStart, dimStart + 15], [1, 0.1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const logoScale = spring({
    frame: frame - 96,
    fps,
    config: springs.smooth,
    from: 0.85,
    to: 1,
  });
  const logoOp = interpolate(frame, [96, 108], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const subOp = interpolate(frame, [116, 136], [0, 0.8], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: C.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
      }}
    >
      <DotGrid opacity={0.08} />

      {/* Phase 1 lines */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          opacity: lineDim,
          position: 'absolute',
          top: frame < dimStart ? 200 : 120,
          transition: 'none',
        }}
      >
        {lines.map((l, i) => {
          const words = l.text.split(' ');
          return (
            <div key={i} style={{display: 'flex', gap: 10}}>
              {words.map((w, j) => {
                const start = l.at + j * 6;
                const op = interpolate(frame, [start, start + 12], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                });
                const ty = interpolate(frame, [start, start + 18], [14, 0]);
                return (
                  <span
                    key={j}
                    style={{
                      fontSize: l.size,
                      fontWeight: l.weight,
                      color: l.color,
                      opacity: op,
                      transform: `translateY(${ty}px)`,
                      letterSpacing: -0.6,
                    }}
                  >
                    {w}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Phase 2 logo */}
      <div
        style={{
          position: 'absolute',
          top: 280,
          left: 0,
          right: 0,
          textAlign: 'center',
          opacity: logoOp,
          transform: `scale(${logoScale})`,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: C.indigo,
              boxShadow: '0 0 0 4px rgba(99,102,241,0.2), 0 0 24px rgba(99,102,241,0.4)',
            }}
          />
          <div
            style={{
              fontSize: 72,
              fontWeight: 900,
              letterSpacing: 4,
              color: C.ink,
            }}
          >
            GOTCHA
          </div>
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 18,
            color: C.muted,
            letterSpacing: 3,
            opacity: subOp,
          }}
        >
          gotcha.ai
        </div>
        <div
          style={{
            marginTop: 40,
            fontSize: 22,
            fontWeight: 700,
            color: C.ink,
            opacity: subOp,
          }}
        >
          This is not customer support.
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 24,
            fontWeight: 900,
            color: C.indigo,
            opacity: subOp,
            letterSpacing: -0.5,
          }}
        >
          This is Customer Communication OS.
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ───────────────────────────────────────────────────────────
// Composition root
// ───────────────────────────────────────────────────────────
// 180 + 120 + 420 + 120 + 300 + 360 + 90 + 240 + 300 + 180 = 2310
export const LAUNCH_TOTAL = 2310;

export const GotchaLaunch: React.FC = () => {
  return (
    <AbsoluteFill style={{background: '#000000', fontFamily: 'Inter'}}>
      <Sequence from={0} durationInFrames={180}>
        <HookScene />
      </Sequence>
      <Sequence from={180} durationInFrames={120}>
        <ShiftScene />
      </Sequence>
      <Sequence from={300} durationInFrames={420}>
        <ChatScene />
      </Sequence>
      <Sequence from={720} durationInFrames={120}>
        <BridgeSlide />
      </Sequence>
      <Sequence from={840} durationInFrames={300}>
        <ActionScene />
      </Sequence>
      <Sequence from={1140} durationInFrames={360}>
        <CopilotScene />
      </Sequence>
      <Sequence from={1500} durationInFrames={90}>
        <LiveCallIntro />
      </Sequence>
      <Sequence from={1590} durationInFrames={240}>
        <CallScene />
      </Sequence>
      <Sequence from={1830} durationInFrames={300}>
        <CommandScene />
      </Sequence>
      <Sequence from={2130} durationInFrames={180}>
        <EndingScene />
      </Sequence>
    </AbsoluteFill>
  );
};
