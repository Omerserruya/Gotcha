import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { campaignSchema } from '@/api/contracts/outreach';
import {
  BroughtIn,
  RepliesByHour,
  ResultStrip,
  SaidNothing,
  WroteBack,
} from '@/features/outreach/CampaignResults';

const loadCampaign = vi.hoisted(() => vi.fn());
vi.mock('@/features/outreach/load-outreach', () => ({ loadCampaign }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ relativeTime: () => 'a while ago' }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const types = (tree: ReactNode): unknown[] => {
  const found: unknown[] = [];
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    found.push(node.type);
    visit((node as ReactElement<{ children?: ReactNode }>).props.children);
  };
  visit(tree);
  return found;
};
const testids = (tree: ReactNode): string[] => {
  const out: string[] = [];
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const id = (node.props as { 'data-testid'?: string })['data-testid'];
    if (id) out.push(id);
    visit((node as ReactElement<{ children?: ReactNode }>).props.children);
  };
  visit(tree);
  return out;
};

const page = async () => {
  const { default: Page } = await import('./page');
  return Page({ params: Promise.resolve({ id: 'b1' }) });
};

beforeEach(() => {
  loadCampaign.mockReset();
});

describe('★★ 05b - one campaign, three answers', () => {
  it('★ ok: the two cards, the strip, the chart, the replies - all mounted', async () => {
    loadCampaign.mockResolvedValue({
      state: 'ok',
      campaign: campaignSchema.parse({
        id: 'b1',
        name: 'Restock',
        status: 'COMPLETED',
        createdAt: '2026-10-02T08:00:00.000Z',
      }),
    });
    const mounted = types(await page());
    for (const part of [BroughtIn, SaidNothing, ResultStrip, RepliesByHour, WroteBack]) {
      expect(mounted).toContain(part);
    }
    expect(loadCampaign).toHaveBeenCalledWith('b1');
  });

  it('⚠ a 404 is "no such campaign", not a failure - and a failure is not a 404', async () => {
    loadCampaign.mockResolvedValue({ state: 'missing' });
    expect(testids(await page())).toContain('results-missing');
    loadCampaign.mockResolvedValue({ state: 'failed' });
    const ids = testids(await page());
    expect(ids).toContain('results-failed');
    expect(ids).not.toContain('results-missing');
  });
});
