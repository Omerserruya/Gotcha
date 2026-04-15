import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';
import {springs} from '../lib/spring';

export const BeatTransition: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const dotBreath = 1 + 0.25 * Math.sin(frame * 0.12);

  const line2Op = interpolate(frame, [65, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const line2TY = spring({
    frame: frame - 65,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 10;

  const outOp = interpolate(frame, [105, 120], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: outOp}}>
      <DotGrid opacity={0.6} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
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
        <div style={{marginTop: 20}}>
          <WordReveal
            text="Handled."
            startFrame={30}
            stagger={8}
            localFrame={frame}
            style={{
              fontSize: 64,
              fontWeight: 900,
              color: C.ink,
              letterSpacing: -1.5,
              justifyContent: 'center',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 28,
            fontWeight: 400,
            color: C.secondary,
            opacity: line2Op,
            transform: `translateY(${line2TY}px)`,
          }}
        >
          No human needed.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
