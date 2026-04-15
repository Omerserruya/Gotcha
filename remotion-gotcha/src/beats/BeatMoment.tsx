import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {springs} from '../lib/spring';

export const BeatMoment: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Entry at f=20
  const raw = spring({
    frame: frame - 20,
    fps,
    config: springs.impact,
    from: 0,
    to: 1,
  });
  // overshoot 0.6 -> 1.04 -> 1
  const scaleIn = 0.6 + raw * 0.48 - Math.max(0, raw - 0.9) * 0.4;
  const opIn = interpolate(frame, [20, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Pulse after entry
  const pulse = 1 + 0.12 * Math.sin((frame - 40) * 0.08);

  // Exit f=155
  const scaleOut = interpolate(frame, [155, 175], [1, 0.9], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opOut = interpolate(frame, [155, 175], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const scale = scaleIn * scaleOut;
  const opacity = opIn * opOut;

  const blur = 32 * pulse;
  const spread = 6 * pulse;
  const outerBlur = 72 * pulse;
  const outerSpread = 18 * pulse;

  return (
    <AbsoluteFill style={{background: C.canvas}}>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div
          style={{
            width: 560,
            height: 76,
            borderRadius: 38,
            background: 'linear-gradient(135deg, #6366F1 0%, #06B6D4 100%)',
            boxShadow: `0 0 0 1px rgba(99,102,241,0.5), 0 0 ${blur}px ${spread}px rgba(99,102,241,0.22), 0 0 ${outerBlur}px ${outerSpread}px rgba(6,182,212,0.12)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FFFFFF',
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: 2,
            transform: `scale(${scale})`,
            opacity,
          }}
        >
          RESOLVED ✓
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
