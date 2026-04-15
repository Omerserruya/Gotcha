import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';
import {springs} from '../lib/spring';

export const BeatFeature1Title: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const line2TY = spring({
    frame: frame - 65,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 10;
  const line2Op = interpolate(frame, [65, 80], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const outOp = interpolate(frame, [105, 115], [1, 0], {
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
          gap: 20,
        }}
      >
        <WordReveal
          text="AI that actually understands."
          startFrame={10}
          stagger={10}
          localFrame={frame}
          style={{
            fontSize: 58,
            fontWeight: 900,
            color: C.ink,
            letterSpacing: -1.5,
            justifyContent: 'center',
          }}
        />
        <div
          style={{
            fontSize: 36,
            fontWeight: 400,
            fontStyle: 'italic',
            color: C.indigo,
            transform: `translateY(${line2TY}px)`,
            opacity: line2Op,
          }}
        >
          Not just responds.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
