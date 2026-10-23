import { describe, expect, it } from 'vitest';

import type { OnboardingV2Step } from '@/api/contracts/onboarding-v2';

import { resumeAt, type ResumeFacts } from './resume-v2';

const facts = (over: Partial<ResumeFacts> = {}): ResumeFacts => ({
  saved: null,
  job: { status: 'COMPLETE' },
  platformConnected: false,
  noSuggestions: false,
  channelConnected: false,
  ...over,
});

describe('★★ where onboarding resumes', () => {
  it('★★ the saved step, exactly, when the server can prove it', () => {
    for (const saved of ['website', 'reading', 'systems', 'channels', 'live'] as const) {
      expect(resumeAt(facts({ saved }))).toBe(saved);
    }
  });

  it('★ a saved step BEHIND the derived one still wins: the user went back on purpose', () => {
    expect(resumeAt(facts({ saved: 'systems', channelConnected: true }))).toBe('systems');
  });

  it.each<[OnboardingV2Step, ResumeFacts['job'], OnboardingV2Step]>([
    ['live', null, 'website'],
    ['systems', null, 'website'],
    ['reading', null, 'website'],
    ['live', { status: 'RUNNING' }, 'reading'],
    ['channels', { status: 'FAILED' }, 'reading'],
    ['systems', { status: 'STALLED' }, 'reading'],
  ])('★★ saved %s past the proof (job %o): the derived step, %s', (saved, job, step) => {
    expect(resumeAt(facts({ saved, job }))).toBe(step);
  });

  describe('nothing saved: derived from the server', () => {
    it('no job → website', () => {
      expect(resumeAt(facts({ job: null }))).toBe('website');
    });

    it.each(['QUEUED', 'RUNNING', 'FAILED', 'STALLED'] as const)(
      '%s job → reading (the feed, or its retry)',
      (status) => {
        expect(resumeAt(facts({ job: { status } }))).toBe('reading');
      },
    );

    it('finished, nothing connected → systems', () => {
      expect(resumeAt(facts())).toBe('systems');
    });

    it('finished, platform connected or nothing to suggest → channels', () => {
      expect(resumeAt(facts({ platformConnected: true }))).toBe('channels');
      expect(resumeAt(facts({ noSuggestions: true }))).toBe('channels');
    });

    it('finished, a channel connected → live', () => {
      expect(resumeAt(facts({ channelConnected: true, platformConnected: true }))).toBe('live');
    });
  });
});
