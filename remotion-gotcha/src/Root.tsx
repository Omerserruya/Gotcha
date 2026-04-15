import React from 'react';
import {Composition} from 'remotion';
import {GotchaVideo} from './GotchaVideo';
import {GotchaLaunch, LAUNCH_TOTAL} from './GotchaLaunch';
import {TOTAL_DURATION} from './lib/timing';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="GotchaDemo"
        component={GotchaVideo}
        durationInFrames={TOTAL_DURATION}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="GotchaLaunch"
        component={GotchaLaunch}
        durationInFrames={LAUNCH_TOTAL}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};
