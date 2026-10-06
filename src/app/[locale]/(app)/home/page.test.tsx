import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HomeScreen } from '@/features/home/HomeScreen';
import { NotificationsPanel } from '@/features/notifications/NotificationsPanel';

vi.mock('@/features/home/HomeScreen', () => ({ HomeScreen: () => null }));
vi.mock('@/features/notifications/NotificationsPanel', () => ({ NotificationsPanel: () => null }));
vi.mock('server-only', () => ({}));
const env = vi.hoisted(() => ({ SETUP_CALL_URL: undefined as string | undefined }));
vi.mock('@/config/env.server', () => ({ serverEnv: () => env }));

function find<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, ReactNode>>;
  if (element.type === type) return element.props as P;
  for (const value of Object.values(element.props ?? {})) {
    const hit = find<P>(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

const page = async (query: Record<string, string> = {}) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(query) });
};

describe('★ 01d - the panel over Home, by query', () => {
  it('only with ?notifications=1', async () => {
    expect(find(await page(), NotificationsPanel)).toBeNull();
    expect(find(await page({ notifications: '1' }), NotificationsPanel)).not.toBeNull();
  });

  it('a known kind filters; anything else is Everything', async () => {
    expect(
      find<{ kind: unknown }>(
        await page({ notifications: '1', kind: 'broken' }),
        NotificationsPanel,
      )?.kind,
    ).toBe('broken');
    expect(
      find<{ kind: unknown }>(await page({ notifications: '1', kind: 'x' }), NotificationsPanel)
        ?.kind,
    ).toBeNull();
  });
});

describe('★ 19 - ?ask= reaches the command box, capped', () => {
  it('passes the question; absent is empty', async () => {
    expect(find<{ ask: string }>(await page({ ask: 'refunds?' }), HomeScreen)?.ask).toBe(
      'refunds?',
    );
    expect(find<{ ask: string }>(await page(), HomeScreen)?.ask).toBe('');
    expect(
      find<{ ask: string }>(await page({ ask: 'x'.repeat(900) }), HomeScreen)?.ask,
    ).toHaveLength(500);
  });
});

describe('★ 01c - "Book a setup call" comes from SETUP_CALL_URL, server side', () => {
  it('set: passed down; unset: null, so no link is drawn', async () => {
    const { default: Page } = await import('./page');
    env.SETUP_CALL_URL = 'https://cal.example/gotcha-setup';
    const set = await Page({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(set)).toContain('https://cal.example/gotcha-setup');
    env.SETUP_CALL_URL = undefined;
    const unset = await Page({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(unset)).not.toContain('cal.example');
  });
});
