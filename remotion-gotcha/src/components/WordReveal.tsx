import React from 'react';
import {interpolate, spring, useVideoConfig} from 'remotion';
import {springs} from '../lib/spring';

export const WordReveal: React.FC<{
  text: string;
  startFrame: number;
  stagger?: number;
  localFrame: number;
  style?: React.CSSProperties;
  wordStyleFn?: (word: string, index: number) => React.CSSProperties;
}> = ({text, startFrame, stagger = 9, localFrame, style, wordStyleFn}) => {
  const {fps} = useVideoConfig();
  const list = text.split(' ');
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        ...style,
      }}
    >
      {list.map((w, i) => {
        const wStart = startFrame + i * stagger;
        if (localFrame < wStart) {
          return (
            <span
              key={i}
              style={{display: 'inline-block', opacity: 0, marginRight: '0.3em'}}
            >
              {w}
            </span>
          );
        }
        const opacity = interpolate(
          localFrame,
          [wStart, wStart + 10],
          [0, 1],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
        );
        const ty =
          spring({
            frame: localFrame - wStart,
            fps,
            config: springs.snappy,
            from: 1,
            to: 0,
          }) * 14;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity,
              transform: `translateY(${ty}px)`,
              marginRight: '0.3em',
              ...(wordStyleFn ? wordStyleFn(w, i) : {}),
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};
