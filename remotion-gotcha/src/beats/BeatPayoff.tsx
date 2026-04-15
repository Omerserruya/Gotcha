import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';
import {springs} from '../lib/spring';

export const BeatPayoff: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const line3Op = interpolate(frame, [110, 125], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const line3TY = spring({
    frame: frame - 110,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 10;

  return (
    <AbsoluteFill style={{background: C.canvas}}>
      <DotGrid opacity={1.0} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <WordReveal
          text="One brain."
          startFrame={15}
          stagger={10}
          localFrame={frame}
          style={{
            fontSize: 72,
            fontWeight: 900,
            color: C.ink,
            letterSpacing: -2,
            justifyContent: 'center',
          }}
        />
        <WordReveal
          text="Every conversation."
          startFrame={60}
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
        <div
          style={{
            marginTop: 8,
            fontSize: 22,
            fontWeight: 400,
            fontStyle: 'italic',
            color: C.secondary,
            opacity: line3Op,
            transform: `translateY(${line3TY}px)`,
          }}
        >
          To the outcome.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
