import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import outreach from '@/i18n/messages/en/outreach.json';
import templates from '@/i18n/messages/en/templates.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
/* Creating writes rows: the actions are spies. */
const actions = vi.hoisted(() => ({
  createCampaignDraft: vi.fn(),
  createTemplate: vi.fn(),
  duplicateTemplate: vi.fn(),
}));
vi.mock('./create-actions', () => actions);
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { outreach }, namespace: namespace as 'outreach' }),
}));

import { CampaignForm, type SendingAccount } from './CampaignForm';
import { DuplicateTemplate } from './DuplicateTemplate';
import { TaskCards } from './TaskCards';
import { TemplateForm, templateName } from './TemplateForm';

const ACCOUNTS: SendingAccount[] = [
  { id: 'wa1', channel: 'WHATSAPP', label: 'WhatsApp · Support line' },
  { id: 'em1', channel: 'EMAIL', label: 'Email · hello@shop.com' },
];
const TEMPLATES = [
  { id: 't1', name: 'restock', language: 'he', channelAccountId: null },
  { id: 't2', name: 'other_number', language: 'he', channelAccountId: 'wa9' },
];

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ outreach, templates }}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  push.mockReset();
  Object.values(actions).forEach((fn) => fn.mockReset());
});

describe('★★ 05 — a campaign, as a DRAFT', () => {
  it('WhatsApp: only approved templates of this number or the tenant’s; nothing saved until the click', async () => {
    wrap(<CampaignForm accounts={ACCOUNTS} templates={TEMPLATES} />);
    const options = [...screen.getByTestId('campaign-template').querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(options).toEqual(['', 't1']);
    expect(screen.getByTestId('campaign-save')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('campaign-template'), 't1');
    await userEvent.type(screen.getByTestId('campaign-name'), '   ');
    expect(screen.getByTestId('campaign-save')).toBeDisabled();
    await userEvent.clear(screen.getByTestId('campaign-name'));
    await userEvent.type(screen.getByTestId('campaign-name'), 'Autumn restock');
    expect(actions.createCampaignDraft).not.toHaveBeenCalled();
    actions.createCampaignDraft.mockResolvedValue({ ok: true, id: 'b9' });
    await userEvent.click(screen.getByTestId('campaign-save'));
    expect(actions.createCampaignDraft.mock.calls[0]![0]).toStrictEqual({
      name: 'Autumn restock',
      channelAccountId: 'wa1',
      channel: 'WHATSAPP',
      templateId: 't1',
    });
    expect(push).toHaveBeenCalledWith({ pathname: '/outreach', query: { campaign: 'b9' } });
  });

  it('★ "When" is day-first and 24-hour; half of it saves nothing', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Jerusalem';
    onTestFinished(() => {
      process.env.TZ = tz;
    });
    wrap(<CampaignForm accounts={ACCOUNTS} templates={TEMPLATES} initialTemplateId="t1" />);
    await userEvent.type(screen.getByTestId('campaign-name'), 'Autumn');
    await userEvent.type(screen.getByTestId('campaign-day'), '4/10/2026');
    await userEvent.tab();
    expect(screen.getByTestId('campaign-day')).toHaveValue('04/10/2026');
    expect(screen.getByTestId('campaign-save')).toBeDisabled();
    expect(screen.getByTestId('campaign-when-hint')).toHaveTextContent(
      'Give both a day and a time',
    );
    await userEvent.type(screen.getByTestId('campaign-time'), '2130');
    await userEvent.tab();
    expect(screen.getByTestId('campaign-time')).toHaveValue('21:30');
    actions.createCampaignDraft.mockResolvedValue({ ok: true, id: 'b2' });
    await userEvent.click(screen.getByTestId('campaign-save'));
    // 21:30 in Israel (UTC+3 in October) — in UTC, local and Z would agree.
    expect(actions.createCampaignDraft.mock.calls[0]![0].scheduledAt).toBe(
      '2026-10-04T18:30:00.000Z',
    );
  });

  it('email: the message itself, no template', async () => {
    wrap(<CampaignForm accounts={ACCOUNTS} templates={TEMPLATES} initialChannel="EMAIL" />);
    expect(screen.queryByTestId('campaign-template')).toBeNull();
    await userEvent.type(screen.getByTestId('campaign-body'), 'Hello');
    await userEvent.type(screen.getByTestId('campaign-name'), 'News');
    actions.createCampaignDraft.mockResolvedValue({ ok: true, id: 'b1' });
    await userEvent.click(screen.getByTestId('campaign-save'));
    expect(actions.createCampaignDraft).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccountId: 'em1', channel: 'EMAIL', body: 'Hello' }),
    );
  });

  it('a refusal in words; no account: where to connect one', async () => {
    actions.createCampaignDraft.mockResolvedValue({ ok: false, reason: 'entitlement' });
    const one = wrap(
      <CampaignForm accounts={ACCOUNTS} templates={TEMPLATES} initialTemplateId="t1" />,
    );
    await userEvent.type(screen.getByTestId('campaign-name'), 'X');
    await userEvent.click(screen.getByTestId('campaign-save'));
    expect(screen.getByTestId('campaign-problem')).toHaveTextContent(
      "Campaigns aren't part of this plan.",
    );
    expect(push).not.toHaveBeenCalled();
    one.unmount();
    wrap(<CampaignForm accounts={[]} templates={[]} />);
    expect(screen.getByTestId('campaign-no-account')).toBeInTheDocument();
  });
});

describe('★★ 05c — a template, as a local DRAFT', () => {
  it.each([
    ['Order Ready HE', 'order_ready_he'],
    ['back-in-stock!', 'back_in_stock'],
    ['שלום', ''],
  ])('templateName(%s) → %s', (typed, name) => {
    expect(templateName(typed)).toBe(name);
  });

  it('saves name, text, category, language and number; opens it', async () => {
    wrap(<TemplateForm accounts={ACCOUNTS} />);
    expect(screen.getByTestId('template-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('template-name'), 'Order Ready');
    await userEvent.type(screen.getByTestId('template-body'), 'Hi, your order is ready');
    actions.createTemplate.mockResolvedValue({ ok: true, id: 'tp1' });
    await userEvent.click(screen.getByTestId('template-save'));
    expect(actions.createTemplate).toHaveBeenCalledWith({
      name: 'order_ready',
      body: 'Hi, your order is ready',
      category: 'MARKETING',
      language: 'he',
      channelAccountId: 'wa1',
    });
    expect(push).toHaveBeenCalledWith({
      pathname: '/outreach/templates',
      query: { template: 'tp1' },
    });
  });
});

describe('★★ 05c — Duplicate', () => {
  it('copies on the click only, then opens the copy; a refusal is said', async () => {
    wrap(<DuplicateTemplate id="tp1" />);
    expect(actions.duplicateTemplate).not.toHaveBeenCalled();
    actions.duplicateTemplate.mockResolvedValueOnce({ ok: true, id: 'tp2' });
    await userEvent.click(screen.getByTestId('template-duplicate'));
    expect(actions.duplicateTemplate).toHaveBeenCalledWith('tp1');
    expect(push).toHaveBeenCalledWith({
      pathname: '/outreach/templates',
      query: { template: 'tp2' },
    });
    actions.duplicateTemplate.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await userEvent.click(screen.getByTestId('template-duplicate'));
    expect(screen.getByTestId('template-duplicate-failed')).toBeInTheDocument();
  });
});

describe('★★ 05 — the four tasks', () => {
  it('Campaign opens the draft; Email only with an email account; Message is drawn with why', async () => {
    const one = render(await TaskCards({ hasEmail: false }));
    expect(screen.getByTestId('task-campaign')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach', query: { create: 'campaign' } }),
    );
    expect(screen.getByTestId('task-email')).not.toHaveAttribute('href');
    expect(screen.getByTestId('task-email')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('task-email').getAttribute('title')).toBeTruthy();
    expect(screen.getByTestId('task-message')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('task-message').getAttribute('title')).toBeTruthy();
    expect(screen.getByTestId('task-call')).toHaveAttribute('href', '/outreach/calls');
    one.unmount();
    render(await TaskCards({ hasEmail: true }));
    expect(screen.getByTestId('task-email')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach', query: { create: 'campaign', channel: 'EMAIL' } }),
    );
  });
});
