import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '../../i18n/messages/en/home.json';

/*
 * Under jsdom, `next-intl/server` resolves to its client build and refuses.
 * These are the real translator and formatter over the real catalogue, so the
 * ICU plurals and the wording are genuinely exercised - only the way they are
 * obtained differs from the server.
 */
/*
 * `timeZone` matches `i18n/request.ts`, which sets `Asia/Jerusalem` for every
 * real request. A formatter without it falls back to the machine's zone (and
 * warns ENVIRONMENT_FALLBACK); one set to UTC formats a different day for any
 * timestamp in the evening. Either way the test renders a date the product
 * never shows, and a date assertion can pass while the screen is a day out.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { home: messages },
      // The component picks its own namespace; the typed key union is the
      // app's business, not this harness's.
      namespace: namespace as never,
    }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

/*
 * The locale-aware Link pulls in next-intl's client navigation, which reaches
 * for Next's router. Routing is not what this file tests, and standing one up
 * would test the mock rather than the block.
 */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import type { KnowledgeIngest, SetupStatus, SetupStep } from '@/api/contracts/setup';

import { FirstSteps } from './FirstSteps';

/**
 * Day one, rendered.
 *
 * The derivations have their own tests; this asserts the thing that can only
 * go wrong once it is on screen - that the block says what is true about the
 * workspace, and says it once.
 */

const step = (overrides: Partial<SetupStep> & { id: string }): SetupStep => ({
  state: 'waiting',
  completedAt: null,
  blockedBy: [],
  estimateMinutes: 5,
  ...overrides,
});

const ingest: KnowledgeIngest = {
  pagesRead: 214,
  answersDrafted: 38,
  answersNeedingConfirmation: 12,
  pendingTopics: [
    { id: '1', topic: 'returns window', category: null },
    { id: '2', topic: 'wholesale pricing', category: null },
    { id: '3', topic: 'delivery to the north', category: null },
    { id: '4', topic: 'gift wrap', category: null },
  ],
  finishedAt: '2026-09-14T09:02:00.000Z',
};

const status: SetupStatus = {
  steps: [
    step({ id: 'connect_channel', state: 'done', completedAt: '2026-09-14T09:06:00.000Z' }),
    step({
      id: 'add_knowledge',
      state: 'done',
      completedAt: '2026-09-14T09:02:00.000Z',
      estimateMinutes: 10,
    }),
    step({ id: 'hire_employee', state: 'next', estimateMinutes: 4 }),
    step({ id: 'connect_store', state: 'waiting', estimateMinutes: 5 }),
    step({
      id: 'handover_rules',
      state: 'blocked',
      blockedBy: ['hire_employee'],
      estimateMinutes: 5,
    }),
  ],
  isLive: false,
  goLive: { eligible: false, blockedBy: ['hire_employee', 'handover_rules'] },
  trial: { daysRemaining: 12, conversationsUsed: 40 },
};

async function renderBlock(setup: SetupStatus = status, scan: KnowledgeIngest = ingest) {
  return render(await FirstSteps({ setup, ingest: scan }));
}

describe('FirstSteps', () => {
  it('raises exactly one step as next', async () => {
    await renderBlock();
    expect(screen.getAllByText('DO THIS NEXT')).toHaveLength(1);
  });

  it('states what is done and how long the rest takes', async () => {
    await renderBlock();
    // Two done; 4 + 5 + 5 minutes left, and the finished steps' 15 excluded.
    expect(screen.getByText('2 done · about 14 minutes left')).toBeInTheDocument();
  });

  /*
   * The scan's numbers are the reassurance: "we read your site" says nothing
   * without how much of it.
   */
  it('folds the scan result into the knowledge step', async () => {
    await renderBlock();
    expect(screen.getByText(/214 pages read, 38 answers drafted/)).toBeInTheDocument();
  });

  /*
   * `pendingTopics` is a sample and `answersNeedingConfirmation` is the total.
   * The count must come from the total, the names from the sample - reading
   * the count off the sample would under-report what is waiting.
   */
  it('counts pending answers from the total, not from the sample — on the knowledge step', async () => {
    await renderBlock();
    const line = screen.getByText(/need your word/);
    expect(line.textContent).toContain('214 pages read');
    expect(line.textContent).toContain('12 need your word');
    expect(line.textContent).toContain('returns window');
    // Four topics were sent; the line names three.
    expect(line.textContent).not.toContain('gift wrap');
  });

  it('says what is in the way of a blocked step', async () => {
    await renderBlock();
    expect(screen.getByText(/Needs Hire your first AI employee first/)).toBeInTheDocument();
  });

  it('★ Go live is locked, with what holds it, while it is not eligible', async () => {
    await renderBlock();
    const button = screen.getByTestId('go-live-button');
    expect(button).toHaveTextContent('Locked');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute(
      'title',
      'Waiting on: Hire your first AI employee, Set the handover rules',
    );
  });

  it('★ eligible, Go live is drawn — and still not live: it is a write', async () => {
    await renderBlock({ ...status, goLive: { eligible: true, blockedBy: [] }, trial: null });
    const button = screen.getByTestId('go-live-button');
    expect(button).toHaveTextContent('Go live');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', expect.stringMatching(/waiting for approval/));
  });

  it.each([
    ['hire_employee', '/studio/employees?hire=1'],
    ['connect_store', '/settings/systems'],
  ])('★ %s opens the screen that completes it', async (id, href) => {
    await renderBlock();
    expect(screen.getByTestId(`step-action-${id}`)).toHaveAttribute('href', href);
  });

  it('★ a step no screen sets is drawn, with why — never a link to the wrong page', async () => {
    await renderBlock();
    const action = screen.getByTestId('step-action-handover_rules');
    expect(action).not.toHaveAttribute('href');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action).toHaveAttribute('title', 'No screen sets this yet.');
  });

  /*
   * No scan yet is not a scan that read nothing. The step must not claim
   * "0 pages read".
   */
  it('omits the scan line entirely when no scan has run', async () => {
    const { container } = await renderBlock(status, null);
    expect(container.textContent).not.toContain('pages read');
  });

  it('shows a step it has no copy for rather than dropping it', async () => {
    await renderBlock({ ...status, steps: [...status.steps, step({ id: 'verify_domain' })] });
    expect(screen.getByText('verify_domain')).toBeInTheDocument();
  });
});
