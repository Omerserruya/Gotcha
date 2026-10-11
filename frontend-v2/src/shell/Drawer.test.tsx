import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** `?panel=` drawers are modal dialogs: Escape is a press on their ×. */
describe('Drawer as a dialog', () => {
  it('a modal dialog named by its title, with focus inside', async () => {
    render(await Drawer({ title: 'Language', closeHref: '/x', children: <button>Save</button> }));
    const dialog = screen.getByRole('dialog', { name: 'Language' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('★ Escape presses the drawer’s own × - one way out', async () => {
    render(await Drawer({ title: 'Language', closeHref: '/x', children: <button>Save</button> }));
    const close = screen.getByRole('dialog').querySelector<HTMLElement>('[data-sheet-close]')!;
    expect(close).toHaveAttribute('aria-label', 'close');
    const pressed = vi.fn((event: Event) => event.preventDefault());
    close.addEventListener('click', pressed);
    await userEvent.keyboard('{Escape}');
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});
