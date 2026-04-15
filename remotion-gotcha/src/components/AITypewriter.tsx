import React from 'react';
import {interpolate} from 'remotion';
import {C} from '../lib/colors';

export const AITypewriter: React.FC<{
  text: string;
  startFrame: number;
  frame: number;
  charsPerFrame?: number;
  color?: string;
  label?: string | null;
  fontSize?: number;
  maxWidth?: number;
  align?: 'left' | 'right' | 'center';
  x?: number;
  y?: number;
  right?: number;
  bottom?: number;
  rtl?: boolean;
  exitFrame?: number;
  cursorColor?: string;
  lineHeight?: number;
  weight?: number;
}> = ({
  text,
  startFrame,
  frame,
  charsPerFrame = 0.5,
  color = C.ink,
  label = 'GOTCHA AI',
  fontSize = 38,
  maxWidth = 820,
  align = 'left',
  x,
  y,
  right,
  bottom,
  rtl,
  exitFrame,
  cursorColor,
  lineHeight = 1.35,
  weight = 500,
}) => {
  if (frame < startFrame) return null;
  const charsVisible = Math.floor(
    interpolate(
      frame,
      [startFrame, startFrame + text.length / charsPerFrame],
      [0, text.length],
      {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
    )
  );
  const visibleText = text.slice(0, charsVisible);
  const showCursor = frame > startFrame && charsVisible < text.length;
  const cursorBlink = Math.floor(frame / 7) % 2 === 0;

  const opacity = interpolate(frame, [startFrame, startFrame + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const exitOp =
    exitFrame !== undefined
      ? interpolate(frame, [exitFrame, exitFrame + 15], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const positionStyle: React.CSSProperties = {position: 'absolute'};
  if (x !== undefined) positionStyle.left = x;
  if (y !== undefined) positionStyle.top = y;
  if (right !== undefined) positionStyle.right = right;
  if (bottom !== undefined) positionStyle.bottom = bottom;

  return (
    <div
      style={{
        ...positionStyle,
        maxWidth,
        textAlign: align,
        direction: rtl ? 'rtl' : 'ltr',
        opacity: opacity * exitOp,
      }}
    >
      {label && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: C.indigo,
            letterSpacing: 2,
            textTransform: 'uppercase',
            marginBottom: 10,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          fontSize,
          fontWeight: weight,
          color,
          lineHeight,
          whiteSpace: 'pre-wrap',
        }}
      >
        {visibleText}
        {showCursor && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 28,
              background: cursorColor || C.indigo,
              marginLeft: 3,
              verticalAlign: 'middle',
              opacity: cursorBlink ? 1 : 0,
            }}
          />
        )}
      </div>
    </div>
  );
};
