import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NotificationsPanel } from '@/features/notifications/NotificationsPanel';

vi.mock('@/features/home/HomeScreen', () => ({ HomeScreen: () => null }));
vi.mock('@/features/notifications/NotificationsPanel', () => ({ NotificationsPanel: () => null }));
vi.mock('server-only', () => ({}));

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

describe('★ 01d — the panel over Home, by query', () => {
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
