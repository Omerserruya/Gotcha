import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverySchema, type ScannedFact } from '@/api/contracts/onboarding';
import { workspaceVoiceSchema } from '@/api/contracts/workspace';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ saveWorkspaceVoice: vi.fn(), previewVoiceSample: vi.fn() }));
vi.mock('@/features/workspace/actions', () => actions);

import { LearnedStep } from './LearnedStep';

const GUIDANCE = 'Warm and short. First names, no emoji, never Dear customer.';
const fact = (id: string, over: Partial<ScannedFact> = {}): ScannedFact => ({
  id,
  title: `Fact ${id}`,
  path: '/shipping',
  ready: true,
  updatedAt: null,
  ...over,
});
const discovery = discoverySchema.parse({
  status: 'COMPLETE',
  crawl: { requested: 220, pagesRead: 142, distinctTextPages: 140 },
  brand: {
    voice: 'Warm',
    tone: 'Short sentences',
    style: 'A long sentence that is much too long to be a chip on the card',
    vocabulary: ['Happy to help'],
    forbiddenWords: ['Dear customer'],
  },
});

const show = (props: Partial<Parameters<typeof LearnedStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <LearnedStep
        discovery={discovery}
        facts={[fact('a'), fact('b', { ready: false, path: null })]}
        voice={workspaceVoiceSchema.parse({ guidance: GUIDANCE, source: 'learned' })}
        {...props}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.saveWorkspaceVoice.mockReset();
  actions.previewVoiceSample.mockReset();
});

describe('★★ 00f - what it knows, as it is in Knowledge', () => {
  it('counts what is there - topics (Knowledge documents), not facts - against the pages read; each with its page; one still learning', () => {
    show();
    expect(screen.getByTestId('learned-count')).toHaveTextContent('2 topics from 142 pages');
    expect(screen.getByTestId('learned-facts')).toHaveTextContent('/shipping');
    expect(screen.getByTestId('learned-facts')).toHaveTextContent('Learning…');
  });

  it('unread is not "none"; none offers to read again', () => {
    const one = show({ facts: null });
    expect(screen.getByTestId('learned-count')).toHaveTextContent("Couldn't read Knowledge");
    one.unmount();
    show({ facts: [] });
    expect(screen.getByTestId('learned-count')).toHaveTextContent('Nothing from your website');
    expect(screen.getByText('Read the website again')).toHaveAttribute(
      'href',
      '/onboarding/website',
    );
  });

  it('page conflicts are not checked - and it says so', () => {
    show();
    expect(screen.getByTestId('learned-conflicts')).toHaveTextContent("aren't checked");
  });
});

describe('★★ how you sound - the words it heard, and the one voice it writes in', () => {
  it('short brand words are chips; a sentence is not; says / never says from the read', () => {
    show();
    expect(screen.getByTestId('voice-traits')).toHaveTextContent('Warm');
    expect(screen.getByTestId('voice-traits')).not.toHaveTextContent('much too long');
    expect(screen.getByTestId('learned-voice')).toHaveTextContent('“Happy to help”');
    expect(screen.getByTestId('learned-voice')).toHaveTextContent('“Dear customer”');
    expect(screen.getByTestId('voice-stored')).toHaveTextContent(GUIDANCE);
  });

  it('the sample is asked for, never written on arrival', async () => {
    actions.previewVoiceSample.mockResolvedValue({
      ok: true,
      reply: 'Hi Dana! It ships tomorrow.',
    });
    show();
    expect(actions.previewVoiceSample).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-ask'));
    });
    expect(actions.previewVoiceSample).toHaveBeenCalledWith(GUIDANCE);
    expect(screen.getByTestId('voice-sample')).toHaveTextContent('Hi Dana!');
  });

  it('Sounds like us goes on; Adjust edits and saves the voice', async () => {
    actions.saveWorkspaceVoice.mockResolvedValue({
      ok: true,
      data: workspaceVoiceSchema.parse({ guidance: `${GUIDANCE} Light humour.`, source: 'edited' }),
    });
    show();
    expect(screen.getByTestId('voice-yes')).toHaveAttribute('href', '/onboarding/truth');
    fireEvent.click(screen.getByTestId('voice-adjust'));
    fireEvent.change(screen.getByTestId('voice-guidance'), {
      target: { value: `${GUIDANCE} Light humour.` },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-save'));
    });
    expect(actions.saveWorkspaceVoice).toHaveBeenCalledWith(`${GUIDANCE} Light humour.`);
    expect(screen.getByTestId('voice-stored')).toHaveTextContent('Light humour.');
  });

  it('no voice yet: the editor is open, and too short is not sent', () => {
    show({ voice: workspaceVoiceSchema.parse({ guidance: null, source: 'none' }) });
    fireEvent.change(screen.getByTestId('voice-guidance'), { target: { value: 'Warm.' } });
    expect(screen.getByTestId('voice-save')).toBeDisabled();
    expect(screen.getByTestId('voice-ask')).toBeDisabled();
    expect(screen.getByTestId('voice-skip')).toHaveAttribute('href', '/onboarding/truth');
  });
});
