import React from 'react';
import {interpolate, spring, useVideoConfig} from 'remotion';
import {springs} from '../lib/spring';

export const GlowPill: React.FC<{
  text: string;
  enterFrame: number;
  frame: number;
  exitFrame?: number;
}> = ({text, enterFrame, frame, exitFrame}) => {
  const {fps} = useVideoConfig();
  if (frame < enterFrame) return null;

  const raw = spring({
    frame: frame - enterFrame,
    fps,
    config: springs.impact,
    from: 0,
    to: 1,
  });
  // overshoot 0.7 -> 1.03 -> 1
  const scale = 0.7 + raw * 0.33 - Math.max(0, raw - 0.9) * 0.3;
  const opacity = interpolate(frame, [enterFrame, enterFrame + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const settle = Math.max(0, frame - enterFrame - 20);
  const pulse = 1 + 0.15 * Math.sin(settle * 0.08);
  const outerBlur = 80 * pulse;
  const outerSpread = 16 * pulse;

  const exitOp =
    exitFrame !== undefined
      ? interpolate(frame, [exitFrame, exitFrame + 15], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) scale(${scale})`,
        width: 560,
        height: 80,
        borderRadius: 40,
        background: 'linear-gradient(135deg, #6366F1 0%, #06B6D4 100%)',
        boxShadow: `0 0 0 1px rgba(99,102,241,0.4), 0 0 40px 8px rgba(99,102,241,0.25), 0 0 ${outerBlur}px ${outerSpread}px rgba(6,182,212,0.15)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 28,
        fontWeight: 600,
        letterSpacing: 1,
        opacity: opacity * exitOp,
      }}
    >
      {text}
    </div>
  );
};
