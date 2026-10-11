import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Drawer } from './Drawer';

vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href: _href, ...rest }: { children?: unknown; href: string }) => (
    <a {...rest}>{children as never}</a>
  ),
}));

/** K6: a title somebody wrote (a document's) is set apart; ours is not. */
describe('Drawer title', () => {
  it('a user’s title is isolated in its own direction', async () => {
    render(await Drawer({ title: 'תנאי משלוח', userTitle: true, closeHref: '/x', children: null }));
    const bdi = screen.getByRole('heading', { level: 2 }).querySelector('bdi');
    expect(bdi).toHaveAttribute('dir', 'auto');
    expect(bdi).toHaveTextContent('תנאי משלוח');
  });

  it('our own title is not', async () => {
    render(await Drawer({ title: 'Knowledge item', closeHref: '/x', children: null }));
    expect(screen.getByRole('heading', { level: 2 }).querySelector('bdi')).toBeNull();
  });
});
