import React from 'react';
import {AbsoluteFill} from 'remotion';
import {C} from '../lib/colors';

export const DotGrid: React.FC<{opacity?: number}> = ({opacity = 1}) => {
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        zIndex: 0,
        opacity,
        backgroundImage: `radial-gradient(circle, ${C.dotGrid} 1px, transparent 1px)`,
        backgroundSize: '32px 32px',
      }}
    />
  );
};
