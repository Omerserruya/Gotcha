import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {springs} from '../lib/spring';

const WORD = 'GOTCHA';

export const BeatOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const dotBreath = 1 + 0.25 * Math.sin(frame * 0.12);

  const letterSpacing = interpolate(frame, [20, 60], [16, 4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const tagOp = interpolate(frame, [55, 75], [0, 0.75], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: C.canvas}}>
      <DotGrid opacity={1.0} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
          }}
        >
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: C.indigo,
              transform: `scale(${dotBreath})`,
              boxShadow:
                '0 0 0 10px rgba(99,102,241,0.22), 0 0 0 24px rgba(99,102,241,0.08)',
            }}
          />
          <div
            style={{
              display: 'flex',
              fontSize: 58,
              fontWeight: 900,
              color: C.ink,
              letterSpacing,
            }}
          >
            {WORD.split('').map((ch, i) => {
              const appear = 20 + i * 4;
              const op = interpolate(frame, [appear, appear + 10], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              });
              const ty =
                spring({
                  frame: frame - appear,
                  fps,
                  config: springs.snappy,
                  from: 1,
                  to: 0,
                }) * 14;
              return (
                <span
                  key={i}
                  style={{
                    display: 'inline-block',
                    opacity: op,
                    transform: `translateY(${ty}px)`,
                  }}
                >
                  {ch}
                </span>
              );
            })}
          </div>
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 16,
            color: C.muted,
            letterSpacing: 3,
            opacity: tagOp,
          }}
        >
          gotcha.ai
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
