import React from 'react';
import {spring, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {springs} from '../lib/spring';

export const GlowDot: React.FC<{
  localFrame: number;
  enterFrame: number;
  size?: number;
  color?: string;
}> = ({localFrame, enterFrame, size = 14, color = C.indigo}) => {
  const {fps} = useVideoConfig();
  if (localFrame < enterFrame) return null;
  const enter = spring({
    frame: localFrame - enterFrame,
    fps,
    config: springs.pop,
    from: 0,
    to: 1,
  });
  const breathing = 1 + 0.22 * Math.sin(localFrame * 0.11);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        transform: `scale(${enter * breathing})`,
        boxShadow: `0 0 0 ${size * 0.5}px rgba(99,102,241,0.22), 0 0 0 ${
          size * 1.2
        }px rgba(99,102,241,0.08)`,
      }}
    />
  );
};
