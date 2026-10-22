import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import skillsMessages from '@/i18n/messages/en/skills.json';

const messages = { skills: skillsMessages };
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, ...rest }: { children: ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock('@/shell/PageContainer', () => ({
  PageContainer: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
      {children}
    </div>
  ),
}));
// The library's read never answers: the page must not wait for it.
vi.mock('@/features/skills/load-skills', () => ({
  loadSkillsLibrary: () => new Promise(() => {}),
  loadSkillEmployees: () => new Promise(() => {}),
}));

const { default: Page } = await import('./page');

describe('★★ placeholders, not a blank page (Omer, 2026-10-07)', () => {
  it('the title, the buttons, the table header and the side draw while the library is read', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {await Page({ searchParams: Promise.resolve({}) })}
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByTestId('skills-describe')).toBeInTheDocument();
    expect(await screen.findByTestId('skills-pending')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Skill' })).toBeInTheDocument();
    expect(screen.getByTestId('skills-missing')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading skills')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('skills-table')).toBeNull();
  });
});
