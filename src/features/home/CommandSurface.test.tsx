import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import home from '@/i18n/messages/en/home.json';

// No test may run the agent: anything that reaches it fails loudly.
vi.mock('./use-agent-run', () => ({
  useAgentRun: () => ({
    state: { status: 'idle' },
    run: () => {
      throw new Error('run');
    },
    cancel: () => undefined,
  }),
}));

import { CommandSurface } from './CommandSurface';

const box = (props: Parameters<typeof CommandSurface>[0]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ home }}>
      <CommandSurface {...props} />
    </NextIntlClientProvider>,
  );

const chips = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((text) => text.endsWith('↗'));

describe('★ 01b — the chips shift with the day', () => {
  it('busy: triage', () => {
    box({ tone: 'busy' });
    expect(screen.getByText('Try')).toBeInTheDocument();
    expect(chips()).toEqual([
      'Summarise today ↗',
      "Who's waiting on a reply? ↗",
      'Send a campaign ↗',
    ]);
  });

  it('quiet: improvement, with the open questions counted', () => {
    box({ tone: 'quiet', openQuestions: 4 });
    expect(screen.getByText('While it is quiet')).toBeInTheDocument();
    expect(chips()).toEqual([
      'Answer the 4 open questions ↗',
      'Write to the people who went quiet ↗',
      'Read yesterday back to me ↗',
    ]);
  });

  it('quiet with no count (none, or no read): no number of nothing', () => {
    box({ tone: 'quiet', openQuestions: 0 });
    expect(chips()[0]).toBe('Answer the open questions ↗');
    document.body.innerHTML = '';
    box({ tone: 'quiet', openQuestions: null });
    expect(chips()[0]).toBe('Answer the open questions ↗');
  });
});
