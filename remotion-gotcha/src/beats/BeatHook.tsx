import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';
import {springs} from '../lib/spring';

export const BeatHook: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const line2Scale = spring({
    frame: frame - 105,
    fps,
    config: springs.impact,
    from: 0.85,
    to: 1,
  });
  const line2Op = interpolate(frame, [105, 115], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const outOp = interpolate(frame, [165, 180], [1, 0], {
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
        <div style={{display: 'flex', justifyContent: 'center'}}>
          <WordReveal
            text="Your customers are talking to you."
            startFrame={10}
            stagger={10}
            localFrame={frame}
            style={{
              fontSize: 56,
              fontWeight: 900,
              letterSpacing: -1.5,
              color: C.ink,
              justifyContent: 'center',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 72,
            fontWeight: 900,
            letterSpacing: -2,
            color: C.indigo,
            transform: `scale(${line2Scale})`,
            opacity: line2Op,
          }}
        >
          Right now.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
