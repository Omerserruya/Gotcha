import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';

export const BeatFeature2Title: React.FC = () => {
  const frame = useCurrentFrame();

  const outOp = interpolate(frame, [130, 145], [1, 0], {
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
          gap: 24,
        }}
      >
        <WordReveal
          text="When it needs a human -"
          startFrame={5}
          stagger={10}
          localFrame={frame}
          style={{
            fontSize: 52,
            fontWeight: 900,
            color: C.ink,
            letterSpacing: -1.5,
            justifyContent: 'center',
          }}
        />
        <WordReveal
          text="they're already ready."
          startFrame={75}
          stagger={10}
          localFrame={frame}
          style={{
            fontSize: 56,
            fontWeight: 900,
            color: C.indigo,
            letterSpacing: -1.5,
            justifyContent: 'center',
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
