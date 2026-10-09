import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { unansweredQuestionSchema } from '@/api/contracts/knowledge';
import knowledge from '@/i18n/messages/en/knowledge.json';

/* It writes the knowledge every employee answers from: a spy, always. */
const answerGap = vi.hoisted(() => vi.fn());
vi.mock('./gap-actions', () => ({ answerGap }));

import { GapRow } from './GapRow';

const QUESTION = unansweredQuestionSchema.parse({
  id: 'q1',
  question: 'What time do you dispatch for next-day?',
  timesAsked: 14,
  distinctAskers: 9,
});

beforeEach(() => {
  answerGap.mockReset();
});

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge }}>
      <ul>
        <GapRow question={QUESTION} asked="Asked 14 times by 9 people" />
      </ul>
    </NextIntlClientProvider>,
  );
const typeAnswer = (text: string) =>
  fireEvent.change(screen.getByTestId('gap-input-q1'), { target: { value: text } });
const send = () =>
  act(async () => {
    fireEvent.click(screen.getByTestId('gap-save-q1'));
  });

describe('★★ 08 - answer one, and every employee learns it', () => {
  it('Answer opens the field in place; nothing is sent until "Teach it", and the words go as typed', async () => {
    answerGap.mockResolvedValueOnce({ ok: true, resolvedAt: '2026-10-08T10:00:00Z' });
    show();
    fireEvent.click(screen.getByTestId('gap-answer-q1'));
    expect(screen.getByTestId('gap-save-q1')).toBeDisabled();
    typeAnswer('  By 14:00 - next day anywhere in Israel.  ');
    expect(answerGap).not.toHaveBeenCalled();
    await send();
    expect(answerGap).toHaveBeenCalledWith('q1', '  By 14:00 - next day anywhere in Israel.  ');
    expect(screen.getByTestId('gap-learned-q1')).toHaveTextContent(
      'Learned - every employee answers this now.',
    );
    expect(screen.queryByTestId('gap-input-q1')).toBeNull();
  });

  it('★ saved but not learned: said, the field stays with the words - nothing claims it is answered', async () => {
    answerGap.mockResolvedValueOnce({ ok: false, reason: 'not_learned' });
    show();
    fireEvent.click(screen.getByTestId('gap-answer-q1'));
    typeAnswer('By 14:00.');
    await send();
    expect(screen.getByTestId('gap-problem-q1')).toHaveTextContent('the question stays open');
    expect(screen.getByTestId('gap-input-q1')).toHaveValue('By 14:00.');
    expect(screen.queryByTestId('gap-learned-q1')).toBeNull();
  });

  it('blank is not an answer; Cancel closes with nothing sent', () => {
    show();
    fireEvent.click(screen.getByTestId('gap-answer-q1'));
    typeAnswer('   ');
    expect(screen.getByTestId('gap-save-q1')).toBeDisabled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('gap-input-q1')).toBeNull();
    expect(answerGap).not.toHaveBeenCalled();
  });
});
