import { beforeEach, describe, expect, it, vi } from 'vitest';

/** /onboarding: where an admin coming back resumes. Mocked: no reads. */
const { facts, redirect } = vi.hoisted(() => ({
  facts: { loadResumeFacts: vi.fn() },
  redirect: vi.fn(),
}));
vi.mock('@/features/onboarding/load-onboarding', () => facts);
vi.mock('@/i18n/navigation', () => ({ redirect }));

const { default: Page } = await import('./page');

const base = {
  saved: null,
  job: { status: 'COMPLETE' },
  platformConnected: false,
  noSuggestions: false,
  channelConnected: false,
};
const open = async (over: object, preview = false) => {
  facts.loadResumeFacts.mockResolvedValue({ ...base, ...over });
  await Page({
    params: Promise.resolve({ locale: 'he' }),
    searchParams: Promise.resolve(preview ? { preview: '1' } : {}),
  });
  return redirect.mock.calls.at(-1)?.[0];
};

beforeEach(() => {
  redirect.mockReset();
});

describe('★★ /onboarding resumes where it really is', () => {
  it('★★ the saved step, exactly', async () => {
    expect(await open({ saved: 'channels' })).toEqual({
      href: '/onboarding/channels',
      locale: 'he',
    });
  });

  it('★★ a saved step past the proof: the derived one', async () => {
    expect(await open({ saved: 'channels', job: null })).toMatchObject({
      href: '/onboarding/website',
    });
  });

  it('★ the job could not be read: the saved step, else reading - never back to the address', async () => {
    expect(await open({ saved: 'systems', job: 'unread' })).toMatchObject({
      href: '/onboarding/systems',
    });
    expect(await open({ saved: null, job: 'unread' })).toMatchObject({
      href: '/onboarding/reading',
    });
  });

  it('★ "live" opens step 4, check and go live', async () => {
    expect(await open({ saved: 'live' })).toMatchObject({ href: '/onboarding/live' });
  });

  it('a preview stays one', async () => {
    expect(await open({ saved: 'systems' }, true)).toMatchObject({
      href: { pathname: '/onboarding/systems', query: { preview: '1' } },
    });
  });
});
