import React from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import {C} from './lib/colors';
import {BeatHook} from './beats/BeatHook';
import {BeatProblem} from './beats/BeatProblem';
import {BeatFeature1Title} from './beats/BeatFeature1Title';
import {BeatDemo1} from './beats/BeatDemo1';
import {BeatTransition} from './beats/BeatTransition';
import {BeatFeature2Title} from './beats/BeatFeature2Title';
import {BeatDemo2} from './beats/BeatDemo2';
import {BeatMoment} from './beats/BeatMoment';
import {BeatPayoff} from './beats/BeatPayoff';
import {BeatOutro} from './beats/BeatOutro';

loadFont('normal', {weights: ['400', '700', '900']});

export const GotchaVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{background: C.canvas, fontFamily: 'Inter'}}>
      <Sequence from={0} durationInFrames={190}>
        <BeatHook />
      </Sequence>
      <Sequence from={180} durationInFrames={160}>
        <BeatProblem />
      </Sequence>
      <Sequence from={330} durationInFrames={130}>
        <BeatFeature1Title />
      </Sequence>
      <Sequence from={450} durationInFrames={370}>
        <BeatDemo1 />
      </Sequence>
      <Sequence from={810} durationInFrames={130}>
        <BeatTransition />
      </Sequence>
      <Sequence from={930} durationInFrames={160}>
        <BeatFeature2Title />
      </Sequence>
      <Sequence from={1080} durationInFrames={340}>
        <BeatDemo2 />
      </Sequence>
      <Sequence from={1410} durationInFrames={190}>
        <BeatMoment />
      </Sequence>
      <Sequence from={1590} durationInFrames={160}>
        <BeatPayoff />
      </Sequence>
      <Sequence from={1740} durationInFrames={120}>
        <BeatOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
