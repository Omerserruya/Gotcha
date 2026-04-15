import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {WordReveal} from '../components/WordReveal';
import {DrawPath} from '../components/DrawPath';
import {springs} from '../lib/spring';

const Pill: React.FC<{label: string; bg: string; color: string}> = ({label, bg, color}) => (
  <div
    style={{
      display: 'inline-block',
      background: bg,
      color,
      fontSize: 10,
      fontWeight: 700,
      padding: '4px 10px',
      borderRadius: 99,
      letterSpacing: 0.8,
    }}
  >
    {label}
  </div>
);

export const BeatDemo2: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Card entry f=20
  const cardTX = spring({
    frame: frame - 20,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 300;
  const cardOp = interpolate(frame, [20, 32], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Section 1 f=60 pill, f=75 typewriter
  const s1Op = interpolate(frame, [60, 72], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const s1Text =
    'Customer asked about order status → received tracking. Now requesting cancellation. High-value customer (3 orders).';
  const s1Chars = Math.floor(
    interpolate(frame, [75, 75 + s1Text.length / 3], [0, s1Text.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );

  // Section 2 f=120, f=135 word reveal
  const s2Op = interpolate(frame, [120, 132], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Section 3 f=175
  const s3Op = interpolate(frame, [175, 187], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const s3TY = spring({
    frame: frame - 175,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 10;

  // Label f=200
  const labelOp = interpolate(frame, [200, 215], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const labelTX = spring({
    frame: frame - 200,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * -20;

  const outOp = interpolate(frame, [310, 330], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Section 2 custom render: split by spaces and style glyphs
  const s2Words = '✓ Sent tracking link · ✓ Verified order status · ✗ Cancellation: needs human'.split(
    ' '
  );
  const s2Stagger = 4;
  const s2Start = 135;

  return (
    <AbsoluteFill style={{background: C.warmCream, opacity: outOp}}>
      {/* Left-side label */}
      <div
        style={{
          position: 'absolute',
          left: 60,
          top: 150,
          opacity: labelOp,
          transform: `translateX(${labelTX}px)`,
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.amber,
            maxWidth: 220,
            lineHeight: 1.3,
          }}
        >
          They don&apos;t start from scratch.
        </div>
        <svg width={220} height={6} style={{marginTop: 6, overflow: 'visible'}}>
          <DrawPath
            d="M 0 3 L 220 3"
            startFrame={200}
            duration={24}
            stroke={C.amber}
            strokeWidth={2}
            pathLength={220}
            localFrame={frame}
          />
        </svg>
      </div>

      {/* Card */}
      <div
        style={{
          position: 'absolute',
          left: 340,
          top: 60,
          width: 620,
          background: '#FFFFFF',
          borderRadius: 16,
          borderLeft: `4px solid ${C.amber}`,
          boxShadow: '0 8px 32px rgba(245,158,11,0.10)',
          padding: '28px 32px',
          transform: `translateX(${cardTX}px)`,
          opacity: cardOp,
        }}
      >
        {/* Agent header */}
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: C.indigoPale,
              color: C.indigo,
              fontSize: 16,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            DY
          </div>
          <div style={{flex: 1, fontSize: 16, fontWeight: 600, color: C.ink}}>
            Dana Y. · Agent
          </div>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: C.green,
              boxShadow: '0 0 0 3px rgba(16,185,129,0.20)',
            }}
          />
        </div>

        {/* Section 1 */}
        <div style={{marginTop: 22, opacity: s1Op}}>
          <Pill label="HANDOFF SUMMARY" bg="#FEF3C7" color="#92400E" />
          <div
            style={{
              marginTop: 10,
              fontSize: 15,
              color: C.secondary,
              lineHeight: 1.5,
            }}
          >
            {s1Text.slice(0, s1Chars)}
          </div>
        </div>

        {/* Section 2 */}
        <div style={{marginTop: 20, opacity: s2Op}}>
          <Pill label="WHAT AI ALREADY DID" bg={C.indigoPale} color={C.indigo} />
          <div
            style={{
              marginTop: 10,
              fontSize: 15,
              color: C.ink,
              lineHeight: 1.5,
              display: 'flex',
              flexWrap: 'wrap',
            }}
          >
            {s2Words.map((w, i) => {
              const wStart = s2Start + i * s2Stagger;
              const op = interpolate(frame, [wStart, wStart + 10], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              });
              const ty =
                spring({
                  frame: frame - wStart,
                  fps,
                  config: springs.snappy,
                  from: 1,
                  to: 0,
                }) * 8;
              let color: string | undefined;
              if (w === '✓') color = C.green;
              if (w === '✗') color = C.red;
              return (
                <span
                  key={i}
                  style={{
                    display: 'inline-block',
                    marginRight: '0.35em',
                    opacity: op,
                    transform: `translateY(${ty}px)`,
                    color,
                    fontWeight: color ? 700 : 400,
                  }}
                >
                  {w}
                </span>
              );
            })}
          </div>
        </div>

        {/* Section 3 */}
        <div style={{marginTop: 20, opacity: s3Op, transform: `translateY(${s3TY}px)`}}>
          <Pill label="RECOMMENDED ACTION" bg={C.greenPale} color={C.green} />
          <div
            style={{
              marginTop: 10,
              fontSize: 15,
              fontWeight: 500,
              color: C.ink,
              lineHeight: 1.5,
            }}
          >
            Offer retention incentive before processing cancellation
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
