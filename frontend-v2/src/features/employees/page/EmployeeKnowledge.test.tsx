import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => router,
}));
const save = vi.hoisted(() => vi.fn());
vi.mock('../actions', () => ({ saveEmployeeEdits: save }));

import { EmployeeKnowledge } from './EmployeeKnowledge';
import { employeeKnowledgeSourceSchema, reachOf } from './knowledge-plan';

const source = (id: string, over: Record<string, unknown> = {}) =>
  employeeKnowledgeSourceSchema.parse({ id, name: `KB ${id}`, isActive: true, ...over });

const SOURCES = [
  source('all', { scope: 'all' }),
  source('mine', { scope: 'agent', scopeAgentId: 'a' }),
  source('theirs', { scope: 'agent', scopeAgentId: 'b' }),
  source('dept', { scope: 'department', scopeDepartmentId: 'd1' }),
  source('off', { scope: 'agent', scopeAgentId: 'b', isActive: false }),
];

const tab = (
  sources: typeof SOURCES | null = SOURCES,
  connected = [{ id: 'theirs', name: 'KB theirs' }],
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ employees }} timeZone="UTC">
      <EmployeeKnowledge
        employee={{ id: 'a', name: 'Maya', departmentId: 'd1' }}
        connected={connected}
        sources={sources}
        head={<h1>Maya</h1>}
        tabs={<nav />}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  router.refresh.mockReset();
});

describe('★★ the Knowledge tab: what it reads, and why - the runtime’s rule', () => {
  it('each source says whether this employee reads it, and why', () => {
    tab();
    const why = (id: string) => screen.getByTestId(`knows-${id}-reach`);
    expect(why('all')).toHaveTextContent('Every employee reads it');
    expect(why('mine')).toHaveTextContent('Only this employee reads it');
    expect(why('dept')).toHaveTextContent('Its department reads it');
    expect(why('theirs')).toHaveTextContent('Connected to this employee');
    expect(why('off')).toHaveTextContent('Switched off in Knowledge');
  });

  it('a switch only where connecting changes something - never on a source its scope reaches', () => {
    tab();
    for (const id of ['all', 'mine', 'dept']) {
      expect(screen.queryByTestId(`knows-${id}-on`)).toBeNull();
    }
    expect(screen.getByTestId('knows-theirs-on')).toBeChecked();
    expect(screen.getByTestId('knows-off-on')).not.toBeChecked();
  });

  it('the rule, alone: another department, or another employee’s, is not read unless connected', () => {
    const who = { id: 'a', departmentId: 'd2' };
    expect(reachOf(SOURCES[3]!, who, new Set())).toBe('not');
    expect(reachOf(SOURCES[2]!, who, new Set())).toBe('not');
    expect(reachOf(SOURCES[2]!, who, new Set(['theirs']))).toBe('connected');
  });
});

describe('★★ connecting and disconnecting: the WHOLE list in one PATCH', () => {
  it('Save is off until something changed', () => {
    tab();
    expect(screen.getByTestId('knows-save')).toBeDisabled();
  });

  it('disconnect one, connect another: knowledgeBaseIds is the whole list, sorted', async () => {
    tab(SOURCES, [
      { id: 'theirs', name: 'KB theirs' },
      { id: 'all', name: 'KB all' },
    ]);
    await userEvent.click(screen.getByTestId('knows-theirs-on'));
    await userEvent.click(screen.getByTestId('knows-off-on'));
    await userEvent.click(screen.getByTestId('knows-save'));
    expect(save).toHaveBeenCalledTimes(1);
    // An attachment without a switch ("all") is kept: the PATCH replaces the list.
    expect(save.mock.calls[0]).toEqual(['a', { knowledgeBaseIds: ['all', 'off'] }]);
    expect(await screen.findByTestId('knows-said')).toHaveTextContent('Saved.');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refusal says so, and nothing is refreshed', async () => {
    save.mockResolvedValue({ ok: false, reason: 'forbidden' });
    tab();
    await userEvent.click(screen.getByTestId('knows-theirs-on'));
    await userEvent.click(screen.getByTestId('knows-save'));
    expect(await screen.findByTestId('knows-said')).toHaveTextContent(
      "You don't have permission to change AI employees.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('the workspace’s list unread, or empty', () => {
  it('unread: what is connected, from the employee read, and no switch', () => {
    tab(null);
    expect(screen.getByTestId('knows-unread')).toBeInTheDocument();
    expect(screen.getByTestId('knows-connected')).toHaveTextContent('KB theirs');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('none: says so, with the way to Knowledge', () => {
    tab([]);
    expect(screen.getByTestId('knows-none')).toHaveTextContent('no knowledge in this workspace');
    expect(screen.getByTestId('knows-manage')).toHaveAttribute('href', '/studio/knowledge');
  });
});
