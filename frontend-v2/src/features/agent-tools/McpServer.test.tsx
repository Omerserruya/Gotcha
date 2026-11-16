import { act, fireEvent, render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import capEn from '@/i18n/messages/en/capabilities.json';
import capHe from '@/i18n/messages/he/capabilities.json';
import consoleEn from '@/i18n/messages/en/console.json';

/* ⚠ Mocked - nothing is queued, read or changed. */
const { actions, router } = vi.hoisted(() => ({
  actions: {
    sendMcpServer: vi.fn(),
    editMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    rediscoverMcpServer: vi.fn(),
    setMcpToolLevel: vi.fn(),
  },
  router: { refresh: vi.fn(), replace: vi.fn() },
}));
vi.mock('./agent-tools-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { capabilities: capEn }, namespace: namespace as 'capabilities' }),
  getFormatter: async () => ({
    dateTime: (d: Date) => d.toISOString().slice(0, 16).replace('T', ' '),
  }),
}));

import { server, tool } from './fixtures';
import { McpServerDetail } from './McpServerDetail';
import { McpServerForm } from './McpServerForm';
import { McpToolLevel } from './McpToolLevel';

const o = capEn.ownTools;
const wrap = (node: React.ReactNode, he = false) => (
  <NextIntlClientProvider
    locale={he ? 'he' : 'en'}
    messages={{ capabilities: he ? capHe : capEn, console: consoleEn }}
  >
    {node}
  </NextIntlClientProvider>
);
const detail = async (over: Record<string, unknown> = {}) =>
  render(wrap(await McpServerDetail({ server: server(over) })));

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true });
  }
  router.refresh.mockClear();
  router.replace.mockClear();
});

describe('★★ each server state says where it stands', () => {
  it.each([
    ['PENDING_APPROVAL', 'mcp-pending', o.mcp.pending.lead],
    ['DISCOVERING', 'mcp-discovering', o.mcp.discovering.lead],
    ['FAILED', 'mcp-failed', o.mcp.failed.lead],
    ['REJECTED', 'mcp-rejected', o.mcp.rejected.lead],
    ['SOMETHING_NEW', 'mcp-unknown', o.mcp.unknown],
  ])('%s', async (status, testid, lead) => {
    await detail({ status, tools: [] });
    expect(screen.getByTestId(testid)).toHaveTextContent(lead);
    expect(screen.getByTestId('mcp-state')).toHaveTextContent(
      o.mcp.state[(status === 'SOMETHING_NEW' ? 'UNKNOWN' : status) as 'READY'],
    );
  });

  it('★ a failure is said in words from its code, never the code', async () => {
    await detail({ status: 'FAILED', lastErrorCode: 'auth_rejected', tools: [] });
    expect(screen.getByTestId('mcp-failed-reason')).toHaveTextContent(o.mcp.failure.auth_rejected);
    expect(screen.queryByText('auth_rejected')).toBeNull();
  });

  it('a rejection shows our reason', async () => {
    await detail({ status: 'REJECTED', rejectionReason: 'Not reachable from the internet', tools: [] });
    expect(screen.getByTestId('mcp-rejected-reason')).toHaveTextContent('Not reachable from the internet');
    expect(screen.getByTestId('mcp-edit')).toHaveTextContent(o.mcp.editAndSend);
  });

  it('★ the secret is never on screen; only the header name is', async () => {
    await detail({ auth: { kind: 'header', headerName: 'X-Shop-Key' }, secret: 'leak' });
    expect(screen.getByTestId('mcp-facts')).toHaveTextContent('X-Shop-Key');
    expect(document.body.textContent).not.toContain('leak');
  });

  it('pending offers Withdraw and no re-read; a ready server offers Check for new tools', async () => {
    const { unmount } = await detail({ status: 'PENDING_APPROVAL', tools: [] });
    expect(screen.queryByTestId('mcp-rediscover')).toBeNull();
    expect(screen.getByTestId('mcp-remove')).toHaveTextContent(o.mcp.withdraw);
    unmount();
    await detail();
    expect(screen.getByTestId('mcp-rediscover')).toHaveTextContent(o.mcp.rediscover);
    expect(screen.getByTestId('mcp-remove')).toHaveTextContent(o.mcp.remove);
  });
});

describe('★★ the tools arrive off, each with its risk', () => {
  it('every tool listed, with its risk word, and new ones counted and marked', async () => {
    await detail();
    expect(screen.getByTestId('risk-get_order')).toHaveTextContent(o.risk.read);
    expect(screen.getByTestId('risk-issue_refund')).toHaveTextContent(o.risk.money);
    expect(screen.getByTestId('risk-sync_inventory')).toHaveTextContent(o.risk.UNKNOWN);
    expect(screen.getByTestId('new-sync_inventory')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-new-count')).toHaveTextContent('1 new tool');
    // A tool with no title is named by its own name, as the AI calls it.
    expect(screen.getByTestId('mcp-tool-sync_inventory')).toHaveTextContent('sync_inventory');
  });

  it('a tool the server stopped offering is marked and cannot be changed', async () => {
    await detail({ tools: [tool({ changedSinceLastDiscovery: 'removed', level: 'ask' })] });
    expect(screen.getByTestId('gone-get_order')).toBeInTheDocument();
    expect(screen.getByTestId('level-get_order-never')).toBeDisabled();
  });

  it('★ while the server is not working, the levels say why and cannot be pressed', async () => {
    await detail({ status: 'FAILED' });
    expect(screen.getByTestId('level-blocked-get_order')).toHaveTextContent(o.mcp.tools.blocked);
    expect(screen.getByTestId('level-get_order-execute')).toBeDisabled();
  });
});

describe('★★ Do it · Ask me · Never per tool', () => {
  const level = (over: Record<string, unknown>) =>
    render(wrap(<McpToolLevel serverId="srv_1" tool={tool(over)} />));

  it.each([
    ['irreversible', o.level.lockedIrreversible],
    ['money', o.level.lockedMoney],
    ['other', o.level.lockedUnknown],
  ])('★ %s: "Do it" is locked with its reason, and a press writes nothing', (risk, why) => {
    level({ risk });
    const doIt = screen.getByTestId('level-get_order-execute');
    expect(doIt).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('level-why-get_order')).toHaveTextContent(why);
    fireEvent.click(doIt);
    expect(actions.setMcpToolLevel).not.toHaveBeenCalled();
  });

  it('a read tool may run on its own', async () => {
    level({ risk: 'read' });
    expect(screen.queryByTestId('level-why-get_order')).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('level-get_order-execute')));
    expect(actions.setMcpToolLevel).toHaveBeenCalledWith('srv_1', 'get_order', 'execute');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('★ a refusal puts the stored level back and says why', async () => {
    actions.setMcpToolLevel.mockResolvedValue({ ok: false, reason: 'forbidden' });
    level({ risk: 'change', level: 'never' });
    await act(async () => fireEvent.click(screen.getByTestId('level-get_order-ask')));
    expect(screen.getByTestId('level-get_order-never')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('level-problem-get_order')).toHaveTextContent(o.refusal.forbidden);
  });

  it('★★ v1: the server’s maxLevel caps a read tool at ask, with its own reason', () => {
    level({ risk: 'read', maxLevel: 'ask' });
    expect(screen.getByTestId('level-get_order-execute')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('level-why-get_order')).toHaveTextContent(o.level.lockedCeiling);
  });

  it('★ a stored "execute" the ceiling forbids is still shown as current', () => {
    level({ risk: 'money', level: 'execute' });
    expect(screen.getByTestId('level-get_order-execute')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('level-why-get_order')).toHaveTextContent(capEn.choice.storedAutomatic);
  });
});

describe('★★ connecting a server', () => {
  const type = (testid: string, value: string) =>
    fireEvent.change(screen.getByTestId(testid), { target: { value } });

  it('★ nothing is sent until name, https address and the secret are there', async () => {
    render(wrap(<McpServerForm />));
    expect(screen.getByTestId('mcp-approval-note')).toHaveTextContent(o.form.approvalNote);
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.sendMcpServer).not.toHaveBeenCalled();
    type('mcp-name', 'Orders');
    type('mcp-url', 'http://mcp.example.com');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.sendMcpServer).not.toHaveBeenCalled();
    expect(screen.getByText(o.form.urlInvalid)).toBeInTheDocument();
    type('mcp-url', 'https://mcp.example.com/mcp');
    fireEvent.click(screen.getByTestId('mcp-auth-bearer'));
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.sendMcpServer).not.toHaveBeenCalled();
    type('mcp-secret', 'tok');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.sendMcpServer).toHaveBeenCalledWith({
      name: 'Orders',
      url: 'https://mcp.example.com/mcp',
      authKind: 'bearer',
      headerName: '',
      secret: 'tok',
    });
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/studio/capabilities',
      query: { system: 'mcp', sent: '1' },
    });
  });

  it('★★ an edit warns before a new address goes back to GOTCHA; a new name does not', () => {
    render(wrap(<McpServerForm server={server()} onCancel={() => {}} />));
    type('mcp-name', 'Renamed');
    expect(screen.queryByTestId('mcp-back-to-queue')).toBeNull();
    expect(screen.getByTestId('mcp-send')).toHaveTextContent(o.form.save);
    type('mcp-url', 'https://other.example.com/mcp');
    expect(screen.getByTestId('mcp-back-to-queue')).toHaveTextContent(o.form.backToQueue);
    expect(screen.getByTestId('mcp-send')).toHaveTextContent(o.form.saveAndSend);
  });

  it('★ a new token is an auth change; a new name alone is not', async () => {
    render(wrap(<McpServerForm server={server()} onCancel={() => {}} />));
    type('mcp-name', 'Renamed');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.editMcpServer.mock.calls[0]![2]).toBe(false);
    type('mcp-secret', 'new-token');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.editMcpServer.mock.calls[1]![2]).toBe(true);
  });

  it('★ an edit keeps the stored secret: empty is allowed and says so', async () => {
    render(wrap(<McpServerForm server={server()} onCancel={() => {}} />));
    expect(screen.getByText(o.form.secretKept)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-secret')).toHaveValue('');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    // Nothing about the sign-in changed: no auth goes, so the server is not re-queued.
    expect(actions.editMcpServer).toHaveBeenCalledWith('srv_1', expect.objectContaining({ secret: '' }), false);
  });

  it('★ v1: a new header name needs its value; the stored one belongs to the old name', async () => {
    render(wrap(<McpServerForm server={server({ auth: { kind: 'header', headerName: 'X-Key', hasSecret: true } })} onCancel={() => {}} />));
    type('mcp-header-name', 'X-Other');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.editMcpServer).not.toHaveBeenCalled();
    expect(screen.getByText(o.form.secretMissing)).toBeInTheDocument();
    type('mcp-secret', 'v2');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(actions.editMcpServer).toHaveBeenCalledTimes(1);
  });

  it('a refusal is said in its own words', async () => {
    actions.sendMcpServer.mockResolvedValue({ ok: false, reason: 'invalid_url' });
    render(wrap(<McpServerForm />));
    type('mcp-name', 'Orders');
    type('mcp-url', 'https://10.0.0.5/mcp');
    await act(async () => fireEvent.click(screen.getByTestId('mcp-send')));
    expect(screen.getByTestId('mcp-problem')).toHaveTextContent(o.refusal.invalid_url);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('Hebrew: the address field reads left to right', () => {
    render(wrap(<McpServerForm />, true));
    expect(screen.getByTestId('mcp-url')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('mcp-send')).toHaveTextContent(capHe.ownTools.form.send);
  });
});
