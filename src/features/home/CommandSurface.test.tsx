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

describe('★ 01b - the chips shift with the day', () => {
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

describe('★ 01c - day-one chips', () => {
  it('what was learned, a test, the store', () => {
    box({ tone: 'dayOne' });
    expect(chips()).toEqual([
      'What did you learn from my site? ↗',
      'Send me a test message ↗',
      'Connect my store ↗',
    ]);
  });
});

describe('★ 19 - ASK fills the box, and never sends', () => {
  it('the question is in the box; nothing ran', () => {
    box({ tone: 'busy', initial: 'How many refunds?' });
    expect(screen.getByRole('textbox')).toHaveValue('How many refunds?');
    // The run mock throws if called: reaching here means nothing was sent.
  });
});
