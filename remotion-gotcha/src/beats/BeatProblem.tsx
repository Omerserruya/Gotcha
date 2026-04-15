import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {DotGrid} from '../components/DotGrid';
import {WordReveal} from '../components/WordReveal';
import {springs} from '../lib/spring';

const Channel: React.FC<{
  color: string;
  label: string;
  frame: number;
  appear: number;
  fps: number;
}> = ({color, label, frame, appear, fps}) => {
  const scale = spring({
    frame: frame - appear,
    fps,
    config: springs.impact,
    from: 0,
    to: 1,
  });
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6}}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: color,
          transform: `scale(${scale})`,
        }}
      />
      <div style={{fontSize: 10, color: C.muted}}>{label}</div>
    </div>
  );
};

export const BeatProblem: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const line2TY = spring({
    frame: frame - 75,
    fps,
    config: springs.snappy,
    from: 1,
    to: 0,
  }) * 20;
  const line2Op = interpolate(frame, [75, 85], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const smallTY = spring({
    frame: frame - 100,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 12;
  const smallOp = interpolate(frame, [100, 115], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const exitTY = interpolate(frame, [135, 150], [0, -30], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const exitOp = interpolate(frame, [135, 150], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: C.canvas}}>
      <DotGrid opacity={0.6} />
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          transform: `translateY(${exitTY}px)`,
          opacity: exitOp,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 32,
            top: '40%',
          }}
        >
          <WordReveal
            text="Three channels."
            startFrame={5}
            stagger={10}
            localFrame={frame}
            style={{
              fontSize: 60,
              fontWeight: 900,
              color: C.ink,
              letterSpacing: -1.5,
            }}
          />
          <div style={{display: 'flex', gap: 36, alignItems: 'flex-start', paddingTop: 10}}>
            <Channel color="#25D366" label="WA" frame={frame} appear={40} fps={fps} />
            <Channel color="#E1306C" label="IG" frame={frame} appear={48} fps={fps} />
            <Channel color="#4F8EF7" label="Email" frame={frame} appear={56} fps={fps} />
          </div>
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 52,
            fontWeight: 900,
            color: C.red,
            letterSpacing: -1.5,
            transform: `translateY(${line2TY}px)`,
            opacity: line2Op,
          }}
        >
          One mess.
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 18,
            fontWeight: 400,
            color: C.secondary,
            transform: `translateY(${smallTY}px)`,
            opacity: smallOp,
          }}
        >
          You&apos;re losing customers between the gaps.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
