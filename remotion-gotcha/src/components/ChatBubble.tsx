import React from 'react';
import {interpolate, spring, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {springs} from '../lib/spring';

export const ChatBubble: React.FC<{
  text: string;
  side: 'user' | 'ai';
  x?: number;
  y?: number;
  right?: number;
  bottom?: number;
  enterFrame: number;
  frame: number;
  maxWidth?: number;
  isTyping?: boolean;
  typewriterChars?: number;
  badge?: string;
  exitFrame?: number;
  rtl?: boolean;
}> = ({
  text,
  side,
  x,
  y,
  right,
  bottom,
  enterFrame,
  frame,
  maxWidth = 520,
  isTyping,
  typewriterChars,
  badge,
  exitFrame,
  rtl,
}) => {
  const {fps} = useVideoConfig();
  if (frame < enterFrame) return null;

  const scale = spring({
    frame: frame - enterFrame,
    fps,
    config: springs.snappy,
    from: 0.92,
    to: 1,
  });
  const opacityIn = interpolate(frame, [enterFrame, enterFrame + 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ty =
    spring({
      frame: frame - enterFrame,
      fps,
      config: springs.smooth,
      from: 1,
      to: 0,
    }) * 16;

  const exitOpacity =
    exitFrame !== undefined
      ? interpolate(frame, [exitFrame, exitFrame + 12], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const isAi = side === 'ai';
  const visibleText =
    typewriterChars !== undefined ? text.slice(0, typewriterChars) : text;
  const showCursor =
    typewriterChars !== undefined && typewriterChars < text.length;

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
        padding: '16px 22px',
        fontSize: 18,
        fontWeight: 400,
        lineHeight: 1.5,
        background: isAi ? C.indigo : '#FFFFFF',
        color: isAi ? '#FFFFFF' : '#0F172A',
        border: isAi ? 'none' : '1px solid #E2E8F0',
        borderRadius: isAi ? '6px 24px 24px 24px' : 24,
        boxShadow: isAi
          ? '0 4px 18px rgba(99,102,241,0.25)'
          : '0 2px 12px rgba(99,102,241,0.08)',
        transform: `scale(${scale}) translateY(${ty}px)`,
        transformOrigin: isAi ? 'left center' : 'right center',
        opacity: opacityIn * exitOpacity,
        direction: rtl ? 'rtl' : 'ltr',
        textAlign: rtl ? 'right' : 'left',
      }}
    >
      {badge && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1,
            opacity: 0.85,
            marginBottom: 4,
            textTransform: 'uppercase',
          }}
        >
          {badge}
        </div>
      )}
      {isTyping ? (
        <span style={{display: 'inline-flex', gap: 4}}>
          {[0, 1, 2].map((i) => {
            const t = (frame - enterFrame) * 0.25 + i * 0.7;
            const op = 0.4 + 0.6 * Math.max(0, Math.sin(t));
            return (
              <span
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: isAi ? '#fff' : C.secondary,
                  opacity: op,
                  display: 'inline-block',
                }}
              />
            );
          })}
        </span>
      ) : (
        <>
          {visibleText}
          {showCursor && (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: 20,
                background: isAi ? '#fff' : C.indigo,
                marginLeft: 2,
                verticalAlign: 'middle',
                opacity: Math.floor(frame / 7) % 2 === 0 ? 1 : 0,
              }}
            />
          )}
        </>
      )}
    </div>
  );
};
