import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SETTINGS_SECTIONS } from './navigation';
import { SettingsSection } from './SettingsSection';

describe('★★ S0 — the Settings frame, as 11–18 draw it', () => {
  it('★ the nav is exactly 02’s eight — 13b and 17b are not sections', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'workspace',
      'people',
      'channels',
      'systems',
      'notifications',
      'security',
      'billing',
      'developer',
    ]);
  });

  it('★ each former section still lights its parent: its path starts with the parent’s', () => {
    const href = (id: string) => SETTINGS_SECTIONS.find((s) => s.id === id)!.href!;
    expect('/settings/channels/whatsapp'.startsWith(`${href('channels')}/`)).toBe(true);
    expect('/settings/billing/plan'.startsWith(`${href('billing')}/`)).toBe(true);
  });

  it('the header is a row: the title and its line, the action beside them', () => {
    render(
      <SettingsSection
        title="People & teams"
        description="Four people"
        actions={<button type="button">Invite someone</button>}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'People & teams' });
    const row = heading.parentElement!.parentElement!;
    expect(row).toContainElement(screen.getByRole('button', { name: 'Invite someone' }));
    // The action is NOT under the subtitle: it is the heading block's sibling.
    expect(heading.parentElement).not.toContainElement(
      screen.getByRole('button', { name: 'Invite someone' }),
    );
  });

  it('a sub-page carries its way back above the title', () => {
    render(
      <SettingsSection
        title="Change plan"
        back={{ href: '/settings/billing', label: 'Usage & billing' }}
      />,
    );
    const back = screen.getByTestId('settings-back');
    expect(back).toHaveAttribute('href', '/settings/billing');
    expect(back).toHaveTextContent('← Usage & billing');
  });
});
