import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runListSchema, runOneSchema } from '@/api/contracts/automations';
import en from '@/i18n/messages/en/automations.json';
import he from '@/i18n/messages/he/automations.json';

const actions = vi.hoisted(() => ({ readRuns: vi.fn(), readRun: vi.fn() }));
vi.mock('./automation-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { RunLog } from './RunLog';
import { RUN_REASONS, runReason, STEP_REASONS, stepReason } from './run-reasons';

beforeEach(() => {
  actions.readRuns.mockReset();
  actions.readRun.mockReset();
});

describe('★★ a run says why in words, never the code', () => {
  it('run.error: a known code, a prefix, or "other" - never itself', () => {
    expect(runReason('opted_out')).toBe('opted_out');
    expect(runReason('no_prior_contact_or_consent')).toBe('no_prior_contact_or_consent');
    expect(runReason('stopped: purchased')).toBe('purchased');
    expect(runReason('failed: Meta said no')).toBe('failed');
    expect(runReason('something_new')).toBe('other');
    expect(runReason('')).toBeNull();
    expect(runReason(null)).toBeNull();
  });

  it("a step's output.action: a known skip, or none", () => {
    expect(stepReason({ action: 'skipped_missing_removal_line' })).toBe(
      'skipped_missing_removal_line',
    );
    expect(stepReason({ action: 'skipped_something_new' })).toBeNull();
    expect(stepReason({ action: 3 })).toBeNull();
    expect(stepReason(null)).toBeNull();
  });

  it('every reason has words in both languages', () => {
    for (const messages of [en, he]) {
      const words = messages.runLog as {
        reason: Record<string, string>;
        stepReason: Record<string, string>;
      };
      expect(Object.keys(words.reason).sort()).toEqual([...RUN_REASONS].sort());
      expect(Object.keys(words.stepReason).sort()).toEqual([...STEP_REASONS].sort());
    }
  });
});

describe('★★ the run log', () => {
  const run = (over: Record<string, unknown>) => ({
    id: 'r1',
    automationId: 'a1',
    status: 'skipped',
    startedAt: '2026-10-08T09:00:00Z',
    ...over,
  });
  const open = async (one: Record<string, unknown>) => {
    actions.readRuns.mockResolvedValue({
      runs: runListSchema.parse({ data: [run({})] }).data,
      nextCursor: null,
    });
    actions.readRun.mockResolvedValue(runOneSchema.parse({ data: run(one) }).data);
    await act(async () => {
      render(
        <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ automations: en }}>
          <RunLog automationId="a1" />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-r1'));
    });
  };

  it('a skipped run: the reason in words, the code on the title only', async () => {
    await open({ error: 'no_prior_contact_or_consent', steps: [] });
    const reason = screen.getByTestId('run-reason');
    expect(reason).toHaveTextContent("the customer never wrote to you and didn't agree");
    expect(reason).toHaveAttribute('title', 'no_prior_contact_or_consent');
    expect(screen.getByTestId('run-trace')).not.toHaveTextContent('no_prior_contact_or_consent');
  });

  it('★ a template step skipped before 4e0e3ced read "ok": it shows as skipped, with why', async () => {
    await open({
      status: 'completed',
      steps: [
        {
          nodeId: 'n1',
          nodeType: 'send_message_template',
          status: 'ok',
          output: { action: 'skipped_missing_removal_line' },
        },
      ],
    });
    const step = screen.getByTestId('run-trace').querySelector('li');
    expect(step).toHaveAttribute('data-status', 'skipped');
    expect(step).toHaveTextContent('Skipped · the template has no removal line');
    expect(step).not.toHaveTextContent('Done');
  });

  it('a step with no skip keeps its status', async () => {
    await open({
      status: 'completed',
      steps: [
        {
          nodeId: 'n1',
          nodeType: 'send_message_template',
          status: 'ok',
          output: { action: 'sent' },
        },
      ],
    });
    expect(screen.getByTestId('run-trace').querySelector('li')).toHaveAttribute(
      'data-status',
      'ok',
    );
  });
});
