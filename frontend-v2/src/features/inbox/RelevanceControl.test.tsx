import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

/**
 * ★★ The tag and the one-click override (Omer, 2026-11-17). The action is
 * mocked: nothing here changes a real conversation.
 */
const setConversationRelevance = vi.hoisted(() => vi.fn());
vi.mock('./conversation-actions', () => ({ setConversationRelevance }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { RelevanceControl } from './RelevanceControl';

beforeEach(() => {
  setConversationRelevance.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

const show = (tag: 'personal' | 'notice' | 'marketing' | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ inbox: locale === 'en' ? en : he }}>
      <RelevanceControl
        conversationId="c1"
        tag={tag}
        override={tag === null ? 'personal' : 'business'}
      />
    </NextIntlClientProvider>,
  );

const press = (testId: string) =>
  act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });

describe('★★ a conversation the platform calls not relevant', () => {
  it.each([
    ['personal', en.relevance.tag.personal],
    ['notice', en.relevance.tag.notice],
    ['marketing', en.relevance.tag.marketing],
  ] as const)('%s wears its type and offers "business"', (tag, words) => {
    show(tag);
    expect(screen.getByTestId('relevance-tag-c1')).toHaveTextContent(words);
    expect(screen.getByTestId('relevance-business-c1')).toHaveTextContent(
      en.relevance.markBusiness,
    );
    expect(screen.queryByTestId('relevance-personal-c1')).toBeNull();
  });

  it('★★ one click moves it back: `business`, then the page is read again', async () => {
    show('notice');
    await press('relevance-business-c1');
    expect(setConversationRelevance).toHaveBeenCalledWith('c1', 'business');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('★★ a normal conversation', () => {
  it('★★ no tag, and "Mark as not relevant", which sends `personal`', async () => {
    show(null);
    expect(screen.queryByTestId('relevance-tag-c1')).toBeNull();
    expect(screen.getByTestId('relevance-personal-c1')).toHaveTextContent(
      en.relevance.markIrrelevant,
    );
    await press('relevance-personal-c1');
    expect(setConversationRelevance).toHaveBeenCalledWith('c1', 'personal');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('★ a refusal says what did not happen, and reads nothing again', () => {
  it.each([
    ['not_allowed', en.relevance.problem.not_allowed],
    ['not_found', en.relevance.problem.not_found],
    ['failed', en.relevance.problem.failed],
    // A reason this control has no words of its own for is "failed".
    ['already_claimed', en.relevance.problem.failed],
  ])('%s', async (reason, words) => {
    setConversationRelevance.mockResolvedValue({ ok: false, reason });
    show('personal');
    await press('relevance-business-c1');
    expect(screen.getByRole('alert')).toHaveTextContent(words);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Hebrew: Omer’s words, no English word and no dash', () => {
  it('the tags and the two buttons', () => {
    show('marketing', 'he');
    expect(screen.getByTestId('relevance-tag-c1')).toHaveTextContent('דיוור או פרסומת');
    expect(screen.getByTestId('relevance-business-c1')).toHaveTextContent('זו פנייה עסקית');
    expect(he.relevance.markIrrelevant).toBe('סמנו כלא רלוונטי');
    expect(he.relevance.tag).toEqual({
      personal: 'אישי',
      notice: 'חשבונית או התראה',
      marketing: 'דיוור או פרסומת',
      auto_reply: 'מענה אוטומטי',
      internal: 'צוות',
    });
    const words = JSON.stringify(he.relevance);
    expect(words.replace(/"[a-z_A-Z]+":/g, '')).not.toMatch(/[A-Za-z]/);
    for (const ch of words) expect([0x2013, 0x2014]).not.toContain(ch.codePointAt(0));
  });
});

describe('★★ what the mark did to its sender - only when the response says so', () => {
  it.each([
    ['applied', 'notice', 'relevance-business-c1', en.relevance.sender.applied],
    ['lifted', 'personal', 'relevance-business-c1', en.relevance.sender.lifted],
  ] as const)('%s: the line, as a status', async (senderRule, tag, button, words) => {
    setConversationRelevance.mockResolvedValue({ ok: true, senderRule });
    show(tag);
    await press(button);
    const line = screen.getByTestId('relevance-sender-c1');
    expect(line).toHaveTextContent(words);
    expect(line).toHaveAttribute('role', 'status');
  });

  it('★★ not said (today’s response): no line, on a personal mark too', async () => {
    setConversationRelevance.mockResolvedValue({ ok: true, senderRule: null });
    show(null);
    await press('relevance-personal-c1');
    expect(setConversationRelevance).toHaveBeenCalledWith('c1', 'personal');
    expect(screen.queryByTestId('relevance-sender-c1')).toBeNull();
  });

  it('a refused mark draws no sender line', async () => {
    setConversationRelevance.mockResolvedValue({ ok: false, reason: 'failed' });
    show(null);
    await press('relevance-personal-c1');
    expect(screen.queryByTestId('relevance-sender-c1')).toBeNull();
  });

  it('Hebrew: "this sender", plural address, no dash', () => {
    expect(he.relevance.sender).toEqual({
      applied: 'מעכשיו, שיחות חדשות מהשולח הזה בערוץ הזה ייכנסו כאישיות.',
      lifted: 'מעכשיו, שיחות חדשות מהשולח הזה בערוץ הזה ייכנסו כרגיל.',
    });
  });
});
