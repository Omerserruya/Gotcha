import React from 'react';
import {interpolate} from 'remotion';

export const DrawPath: React.FC<{
  d: string;
  startFrame: number;
  duration: number;
  stroke: string;
  strokeWidth: number;
  pathLength: number;
  fill?: string;
  localFrame: number;
}> = ({
  d,
  startFrame,
  duration,
  stroke,
  strokeWidth,
  pathLength,
  fill = 'none',
  localFrame,
}) => {
  const offset = interpolate(
    localFrame,
    [startFrame, startFrame + duration],
    [pathLength, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  return (
    <path
      d={d}
      stroke={stroke}
      strokeWidth={strokeWidth}
      fill={fill}
      strokeDasharray={pathLength}
      strokeDashoffset={offset}
      strokeLinecap="round"
    />
  );
};
