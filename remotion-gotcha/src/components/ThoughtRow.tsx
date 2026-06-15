import React from 'react';
import {interpolate, spring, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {springs} from '../lib/spring';

export const ThoughtRow: React.FC<{
  text: string;
  iconColor: string;
  appearFrame: number;
  localFrame: number;
  isAction?: boolean;
  // legacy props kept so existing callers don't break
  shimmerUntil?: number;
  textSwapFrame?: number;
  newText?: string;
  iconSwapFrame?: number;
  newIconColor?: string;
}> = ({
  text,
  iconColor,
  appearFrame,
  localFrame,
  isAction,
  textSwapFrame,
  newText,
  iconSwapFrame,
  newIconColor,
}) => {
  const {fps} = useVideoConfig();
  if (localFrame < appearFrame) return null;

  // Phase 1: dot (0..8) - ring scale impact then fill at +8
  const dotRaw = spring({
    frame: localFrame - appearFrame,
    fps,
    config: springs.impact,
    from: 0,
    to: 1,
  });
  // overshoot 0 -> 1.2 -> 1
  const dotScale = dotRaw * 1.2 - Math.max(0, dotRaw - 0.85) * 0.2;
  const filled = localFrame >= appearFrame + 8;

  // Phase 2: text typing (startFrame+8 onward)
  const typeStart = appearFrame + 8;
  const typeEnd = typeStart + text.length * 2;
  const chars = Math.floor(
    interpolate(localFrame, [typeStart, typeEnd], [0, text.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );
  const showCursor = localFrame >= typeStart && chars < text.length;
  const cursorBlink = Math.floor(localFrame / 7) % 2 === 0;

  const currentIcon =
    iconSwapFrame !== undefined && newIconColor && localFrame >= iconSwapFrame
      ? newIconColor
      : iconColor;
  const currentText =
    textSwapFrame !== undefined && newText && localFrame >= textSwapFrame
      ? newText
      : text;
  const visibleText = currentText.slice(0, chars);

  // Badge: after text finishes typing
  const badgeStart = typeEnd + 2;
  const badgeScale = spring({
    frame: localFrame - badgeStart,
    fps,
    config: springs.impact,
    from: 0,
    to: 1,
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 12px',
        marginTop: 12,
        minHeight: 32,
        background: isAction ? 'rgba(16,185,129,0.08)' : 'transparent',
        borderLeft: isAction ? `3px solid ${C.green}` : '3px solid transparent',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          flexShrink: 0,
          transform: `scale(${Math.max(0.01, dotScale)})`,
          background: filled ? currentIcon : 'transparent',
          border: filled ? 'none' : `2px solid ${currentIcon}`,
          boxSizing: 'border-box',
        }}
      />
      <div
        style={{
          flex: 1,
          fontSize: 16,
          color: C.ink,
          fontWeight: 500,
          lineHeight: 1.35,
        }}
      >
        {visibleText}
        {showCursor && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 18,
              background: C.indigo,
              marginLeft: 2,
              verticalAlign: 'middle',
              opacity: cursorBlink ? 1 : 0,
            }}
          />
        )}
      </div>
      {isAction && localFrame >= badgeStart && (
        <span
          style={{
            background: C.green,
            color: C.white,
            fontSize: 10,
            fontWeight: 800,
            padding: '2px 8px',
            borderRadius: 99,
            letterSpacing: 0.6,
            transform: `scale(${badgeScale})`,
          }}
        >
          ⚡ EXECUTED
        </span>
      )}
    </div>
  );
};
