import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../lib/colors';
import {AITypewriter} from '../components/AITypewriter';
import {ThoughtRow} from '../components/ThoughtRow';
import {springs} from '../lib/spring';

export const BeatDemo1: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const inOp = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outOp = interpolate(frame, [350, 360], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rootOp = inOp * outOp;

  // Customer bubble at f=30
  const bubbleScale = spring({
    frame: frame - 30,
    fps,
    config: springs.snappy,
    from: 0.9,
    to: 1,
  });
  const bubbleOp = interpolate(frame, [30, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const bubbleTY = spring({
    frame: frame - 30,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 20;

  // AI label f=60
  const labelOp = interpolate(frame, [60, 75], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Reasoning panel f=20
  const panelTX = spring({
    frame: frame - 20,
    fps,
    config: springs.smooth,
    from: 1,
    to: 0,
  }) * 200;
  const panelOp = interpolate(frame, [20, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: C.canvas, opacity: rootOp}}>
      {/* LEFT ZONE */}
      <div
        style={{
          position: 'absolute',
          left: 60,
          top: 80,
          width: 560,
          height: 560,
        }}
      >
        {/* Customer bubble */}
        <div
          style={{
            position: 'absolute',
            top: 20,
            right: 20,
            maxWidth: 380,
            padding: '14px 20px',
            background: '#FFFFFF',
            border: `0.5px solid ${C.border}`,
            borderRadius: '24px 24px 6px 24px',
            fontSize: 18,
            color: C.ink,
            direction: 'rtl',
            textAlign: 'right',
            boxShadow: '0 2px 10px rgba(99,102,241,0.05)',
            transform: `scale(${bubbleScale}) translateY(${bubbleTY}px)`,
            opacity: bubbleOp,
          }}
        >
          היי, איפה ההזמנה שלי? 📦
        </div>

        {/* AI label */}
        <div
          style={{
            position: 'absolute',
            top: 130,
            left: 0,
            fontSize: 11,
            fontWeight: 600,
            color: C.indigo,
            letterSpacing: 1,
            textTransform: 'uppercase',
            opacity: labelOp,
          }}
        >
          GOTCHA AI
        </div>

        {/* AI Typewriter */}
        <div
          style={{
            position: 'absolute',
            top: 160,
            left: 0,
            maxWidth: 520,
            direction: 'rtl',
            textAlign: 'right',
          }}
        >
          <AITypewriter
            text={'ההזמנה שלך בדרך! 🚚\nמספר מעקב: IL928451.\nצפי הגעה: מחר עד 18:00'}
            startFrame={80}
            frame={frame}
            charsPerFrame={2}
            color={C.ink}
            label={null}
            fontSize={28}
            maxWidth={520}
            align="right"
            rtl
            lineHeight={1.5}
            weight={400}
          />
        </div>
      </div>

      {/* RIGHT ZONE - Reasoning Panel */}
      <div
        style={{
          position: 'absolute',
          right: 40,
          top: 180,
          width: 420,
          padding: 20,
          background: '#FFFFFF',
          border: `0.5px solid ${C.border}`,
          borderRadius: 16,
          boxShadow: '0 4px 24px rgba(99,102,241,0.08)',
          transform: `translateX(${panelTX}px)`,
          opacity: panelOp,
        }}
      >
        {/* Header */}
        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: C.indigo,
              boxShadow: '0 0 0 3px rgba(99,102,241,0.20)',
            }}
          />
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: C.indigo,
              letterSpacing: 0.5,
            }}
          >
            GOTCHA AI · REASONING
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            height: 1,
            background: C.border,
          }}
        />
        {/* Rows - stagger 45 */}
        <ThoughtRow
          text="Intent detected: order_status_check"
          iconColor={C.indigo}
          appearFrame={30}
          localFrame={frame}
        />
        <ThoughtRow
          text="Order #4821 · Shipped Nov 12 · In transit"
          iconColor={C.green}
          appearFrame={75}
          localFrame={frame}
        />
        <ThoughtRow
          text="Action: send_tracking_link"
          iconColor={C.green}
          appearFrame={120}
          localFrame={frame}
          isAction
        />
      </div>
    </AbsoluteFill>
  );
};
