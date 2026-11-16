import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import capEn from '@/i18n/messages/en/capabilities.json';
import capHe from '@/i18n/messages/he/capabilities.json';
import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/* ⚠ Mocked - no tool is saved, deleted or fired at anyone's API. */
const { actions, router } = vi.hoisted(() => ({
  actions: {
    saveCustomApiTool: vi.fn(),
    deleteCustomApiTool: vi.fn(),
    testCustomApiTool: vi.fn(),
    decideMcpServer: vi.fn(),
  },
  router: { refresh: vi.fn(), replace: vi.fn() },
}));
vi.mock('./agent-tools-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router }));

import { CustomApiTools } from './CustomApiTools';
import { customTool, pending } from './fixtures';
import { McpQueue } from './McpQueue';

const c = capEn.ownTools.custom;
const q = consoleEn.toolsQueue;
const wrap = (node: React.ReactNode, he = false) => (
  <NextIntlClientProvider
    locale={he ? 'he' : 'en'}
    messages={{ capabilities: he ? capHe : capEn, console: he ? consoleHe : consoleEn }}
  >
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true });
  }
  router.refresh.mockClear();
});

describe('★★ custom API tools', () => {
  it('none yet: says so, and Add opens the builder', () => {
    render(wrap(<CustomApiTools tools={[]} />));
    expect(screen.getByTestId('custom-empty')).toHaveTextContent(c.emptyLead);
    fireEvent.click(screen.getByTestId('custom-add'));
    expect(screen.getByTestId('custom-new')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-empty')).toBeNull();
  });

  it('each tool: its name, risk, method and host, and Off when switched off', () => {
    render(
      wrap(
        <CustomApiTools
          tools={[customTool(), customTool({ id: 'cat_2', slug: 'cancel', name: 'Cancel', method: 'POST', category: 'DELETE', isActive: false })]}
        />,
      ),
    );
    const row = screen.getByTestId('custom-tool-lookup_order');
    expect(row).toHaveTextContent('GET api.shop-example.co.il');
    expect(screen.getByTestId('custom-risk-lookup_order')).toHaveTextContent(capEn.ownTools.risk.read);
    expect(screen.getByTestId('custom-risk-cancel')).toHaveTextContent(capEn.ownTools.risk.irreversible);
    expect(screen.getByTestId('custom-off-cancel')).toHaveTextContent(c.off);
    expect(screen.queryByTestId('custom-off-lookup_order')).toBeNull();
  });

  it('★ the builder catches what the route would refuse, before any request', async () => {
    render(wrap(<CustomApiTools tools={[]} />));
    fireEvent.click(screen.getByTestId('custom-add'));
    await act(async () => fireEvent.click(screen.getByTestId('custom-save')));
    expect(actions.saveCustomApiTool).not.toHaveBeenCalled();
    expect(screen.getByTestId('custom-problems')).toHaveTextContent(c.problemsSummary);
    expect(screen.getByText(c.problem.name)).toBeInTheDocument();
  });

  it('★★ an edit opens with the stored values, never the secret, and saves by id', async () => {
    render(wrap(<CustomApiTools tools={[customTool()]} />));
    fireEvent.click(screen.getByTestId('custom-edit-lookup_order'));
    expect(screen.getByTestId('custom-slug')).toBeDisabled();
    expect(screen.getByTestId('custom-bearer')).toHaveValue('');
    expect(screen.getByText(capEn.ownTools.form.secretKept)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('custom-save')));
    expect(actions.saveCustomApiTool).toHaveBeenCalledWith('cat_1', expect.objectContaining({ slug: 'lookup_order' }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('a taken slug is said in words', async () => {
    actions.saveCustomApiTool.mockResolvedValue({ ok: false, reason: 'slug_taken' });
    render(wrap(<CustomApiTools tools={[customTool()]} />));
    fireEvent.click(screen.getByTestId('custom-edit-lookup_order'));
    await act(async () => fireEvent.click(screen.getByTestId('custom-save')));
    expect(screen.getByTestId('custom-refusal')).toHaveTextContent(capEn.ownTools.refusal.slug_taken);
  });

  it('★★ a test says it is real, refuses bad JSON, and shows status, time and response', async () => {
    actions.testCustomApiTool.mockResolvedValue({
      ok: true,
      test: { ok: true, result: { status: 'shipped' }, reason: null, meta: { status: 200, durationMs: 81.4 } },
    });
    render(wrap(<CustomApiTools tools={[customTool({ method: 'POST', category: 'WRITE' })]} />));
    fireEvent.click(screen.getByTestId('custom-test-lookup_order'));
    expect(screen.getByTestId('custom-test-panel-lookup_order')).toHaveTextContent(
      c.test.realWrite.replace('{method}', 'POST'),
    );
    fireEvent.change(screen.getByTestId('custom-test-args-lookup_order'), { target: { value: '[1]' } });
    await act(async () => fireEvent.click(screen.getByTestId('custom-test-run-lookup_order')));
    expect(actions.testCustomApiTool).not.toHaveBeenCalled();
    expect(screen.getByText(c.test.badArgs)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('custom-test-args-lookup_order'), {
      target: { value: '{"order_id":"42"}' },
    });
    await act(async () => fireEvent.click(screen.getByTestId('custom-test-run-lookup_order')));
    expect(actions.testCustomApiTool).toHaveBeenCalledWith('cat_1', { order_id: '42' });
    const result = screen.getByTestId('custom-test-result-lookup_order');
    expect(result).toHaveAttribute('data-ok', 'yes');
    expect(result).toHaveTextContent('status 200');
    expect(result).toHaveTextContent('81 ms');
    expect(result).toHaveTextContent('"shipped"');
  });

  it('a failed test says it did not work, with what came back', async () => {
    actions.testCustomApiTool.mockResolvedValue({
      ok: true,
      test: { ok: false, reason: 'host not allowed', meta: { status: null, durationMs: null } },
    });
    render(wrap(<CustomApiTools tools={[customTool()]} />));
    fireEvent.click(screen.getByTestId('custom-test-lookup_order'));
    await act(async () => fireEvent.click(screen.getByTestId('custom-test-run-lookup_order')));
    const result = screen.getByTestId('custom-test-result-lookup_order');
    expect(result).toHaveAttribute('data-ok', 'no');
    expect(result).toHaveTextContent(c.test.failed);
    expect(result).toHaveTextContent('host not allowed');
  });

  it('★ delete asks first, then deletes by id', async () => {
    render(wrap(<CustomApiTools tools={[customTool()]} />));
    const del = screen.getByTestId('custom-delete-lookup_order');
    fireEvent.click(within(del).getByRole('button', { name: c.delete }));
    expect(actions.deleteCustomApiTool).not.toHaveBeenCalled();
    expect(del).toHaveTextContent(c.deleteSecond);
    await act(async () => fireEvent.click(within(del).getByRole('button', { name: c.deleteYes })));
    expect(actions.deleteCustomApiTool).toHaveBeenCalledWith('cat_1');
  });
});

describe('★★ GOTCHA’s queue', () => {
  const show = (servers = [pending()], he = false) =>
    render(wrap(<McpQueue servers={servers} sentAt={{ srv_1: '16 Nov 2026, 10:12' }} />, he));

  it('empty says so', () => {
    show([]);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(q.empty);
  });

  it('each request: workspace, who, address, sign-in, when - never a secret', () => {
    show([pending({ auth: { kind: 'header', headerName: 'X-Key' }, secret: 'leak' })]);
    const row = screen.getByTestId('queue-srv_1');
    expect(row).toHaveTextContent('Shop Example');
    expect(row).toHaveTextContent('Dana Levi');
    expect(row).toHaveTextContent('https://mcp.shop-example.co.il/mcp');
    expect(row).toHaveTextContent('X-Key');
    expect(row).toHaveTextContent('16 Nov 2026, 10:12');
    expect(row.textContent).not.toContain('leak');
  });

  it('★★ approve asks first, then approves', async () => {
    show();
    const approve = screen.getByTestId('queue-approve-srv_1');
    fireEvent.click(within(approve).getByRole('button', { name: q.approve }));
    expect(actions.decideMcpServer).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(approve).getByRole('button', { name: q.approveYes })));
    expect(actions.decideMcpServer).toHaveBeenCalledWith('srv_1', 'approve', '');
  });

  it('★★ reject cannot be sent without a reason, and sends it', async () => {
    show();
    const reject = screen.getByTestId('queue-reject-srv_1');
    fireEvent.click(within(reject).getByRole('button', { name: q.reject }));
    const yes = within(reject).getByRole('button', { name: q.rejectYes });
    expect(yes).toBeDisabled();
    fireEvent.change(screen.getByTestId('queue-reject-srv_1-reason'), {
      target: { value: 'The address is private' },
    });
    await act(async () => fireEvent.click(yes));
    expect(actions.decideMcpServer).toHaveBeenCalledWith('srv_1', 'reject', 'The address is private');
  });

  it('Hebrew renders its own words', () => {
    show([pending()], true);
    expect(screen.getByTestId('queue-srv_1')).toHaveTextContent(consoleHe.toolsQueue.workspace);
  });
});
