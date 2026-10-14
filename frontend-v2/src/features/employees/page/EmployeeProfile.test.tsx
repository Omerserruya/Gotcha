import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';
import heEmployees from '@/i18n/messages/he/employees.json';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router }));
const save = vi.hoisted(() => vi.fn());
// Pause and delete may not run here: they fail loudly. Save is the one under test.
vi.mock('../actions', () => ({
  setEmployeeStatus: () => {
    throw new Error('write');
  },
  deleteEmployee: () => {
    throw new Error('write');
  },
  saveEmployeeEdits: save,
}));

vi.mock('./tool-level-actions', () => ({ setEmployeeToolLevel: vi.fn() }));

import { EmployeeProfile } from './EmployeeProfile';

const employee = (over: Record<string, unknown> = {}) =>
  employeeSchema.parse({
    id: 'a',
    name: 'Maya',
    tone: 'friendly',
    languages: { english: true },
    identity: { responsibility: 'After-sale questions' },
    escalationRules: [
      { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: true },
      { label: 'Order over 1000', enabled: false },
    ],
    openConversations: 3,
    ...over,
  });

const profile = (
  over: Record<string, unknown> = {},
  props: Record<string, unknown> = {},
  locale: 'en' | 'he' = 'en',
) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ employees: locale === 'en' ? employees : heEmployees }}
      timeZone="UTC"
    >
      <EmployeeProfile
        employee={employee(over)}
        head={<h1>Maya</h1>}
        tabs={<nav data-testid="tabs" />}
        levels={[
          {
            toolName: 'shopify.process_refund',
            label: 'Refund an order',
            workspaceLevel: 'ask',
            ownLevel: null,
            employeeLevel: 'ask',
            allowedLevels: ['ask', 'never'],
            granted: true,
            grantable: true,
          },
        ]}
        access={{
          allowed: ['shopify'],
          choices: [
            { key: 'shopify', kind: 'integration', name: 'Shopify', status: 'CONNECTED' },
            { key: 'woocommerce', kind: 'integration', name: 'WooCommerce', status: 'ERROR' },
          ],
        }}
        {...props}
      />
    </NextIntlClientProvider>,
  );

/** Save, confirm, and the one PATCH body it sent. */
async function saved(): Promise<unknown> {
  await userEvent.click(screen.getByTestId('profile-save'));
  await userEvent.click(await screen.findByTestId('profile-confirm-save'));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]![0]).toBe('a');
  return save.mock.calls[0]![1];
}

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  router.refresh.mockReset();
});

describe('★★ the Profile tab is ONE list, top to bottom, Tools and the handoff inside it', () => {
  it('four parts, in order, in one column - and no tab or page of their own', () => {
    profile();
    const list = screen.getByTestId('employee-profile');
    const parts = [...list.querySelectorAll(':scope > section')].map((s) =>
      s.getAttribute('data-testid'),
    );
    expect(parts).toEqual([
      'profile-responsible',
      'profile-how',
      'profile-tools',
      'profile-limits',
      'profile-handover',
    ]);
    expect(within(list).getByTestId('profile-tools')).toHaveTextContent('Tools');
    expect(within(list).getByTestId('profile-handover')).toHaveTextContent('Handoff to a person');
  });

  it('★ H7: the readiness card is the list’s first part, above the settings', () => {
    profile({}, { readiness: <section data-testid="profile-readiness">Readiness</section> });
    const list = screen.getByTestId('employee-profile');
    expect(
      [...list.querySelectorAll(':scope > section')].map((s) => s.getAttribute('data-testid')),
    ).toEqual([
      'profile-readiness',
      'profile-responsible',
      'profile-how',
      'profile-tools',
      'profile-limits',
      'profile-handover',
    ]);
  });

  it('real content in each: the responsibility, the tone, what it may do, its systems, its rules', () => {
    profile();
    // E3: its tools' sections open closed; open them to read the levels.
    for (const toggle of screen.queryAllByTestId(/^levels-domain-toggle-/)) fireEvent.click(toggle);
    expect(screen.getByTestId('profile-responsibility')).toHaveValue('After-sale questions');
    expect(screen.getByTestId('profile-tone-friendly')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('level-shopify.process_refund-ask')).toHaveAttribute(
      'data-current',
      'yes',
    );
    expect(screen.getByTestId('profile-system-shopify-on')).toBeChecked();
    expect(screen.getByTestId('profile-system-woocommerce-on')).not.toBeChecked();
    expect(screen.getByTestId('profile-rule-0-label')).toHaveValue('Asks for a person');
    expect(screen.getByTestId('profile-rule-1-on')).not.toBeChecked();
  });

  it('nothing changed: Save is off and says so', () => {
    profile();
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    expect(screen.getByTestId('profile-changes')).toHaveTextContent('No changes');
  });
});

describe('★★ "How it answers" (E6): no language choice, no sign-off, a real AI switch', () => {
  it('one line on the language, by rule - no control to choose one', () => {
    profile();
    const how = screen.getByTestId('profile-how');
    expect(screen.getByTestId('profile-language')).toHaveTextContent(
      /^It always answers in the customer's language\. That's a rule, not a setting\.$/,
    );
    expect(within(how).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(how).getAllByRole('switch')).toHaveLength(1);
    expect(how.querySelectorAll('[data-testid*="language-"]')).toHaveLength(0);
    expect(how).not.toHaveTextContent(/English|Hebrew|Arabic/);
  });

  it('no sign-off anywhere on the page', () => {
    profile();
    expect(document.body).not.toHaveTextContent(/sign/i);
  });

  it('Hebrew: no "חותם בשם", and the language line', () => {
    profile({}, {}, 'he');
    expect(document.body).not.toHaveTextContent('חותם');
    expect(screen.getByTestId('profile-language')).toHaveTextContent('תמיד עונה בשפה של הלקוח');
  });

  it('★ absent means on: the switch is on and says so', () => {
    profile();
    expect(screen.getByTestId('profile-discloses')).toBeChecked();
    expect(screen.getByTestId('profile-discloses-says')).toHaveTextContent(
      /^Says it's AI when asked$/,
    );
  });

  it('stored false: off, and the off words', () => {
    profile({ persona: { disclosesAi: false } });
    expect(screen.getByTestId('profile-discloses')).not.toBeChecked();
    expect(screen.getByTestId('profile-discloses-says')).toHaveTextContent(
      "Doesn't bring it up, and never pretends to be a person",
    );
  });

  it('★ switched off: the exact PATCH is { disclosesAi: false }', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-discloses'));
    expect(screen.getByTestId('profile-discloses-says')).toHaveTextContent(
      'never pretends to be a person',
    );
    expect(await saved()).toEqual({ disclosesAi: false });
  });

  it('switched on from off: { disclosesAi: true }', async () => {
    profile({ persona: { disclosesAi: false } });
    await userEvent.click(screen.getByTestId('profile-discloses'));
    expect(await saved()).toEqual({ disclosesAi: true });
  });
});

describe('★★ the handoff: add, edit, remove - the WHOLE array is sent', () => {
  it('★ add: every stored rule as read, then the new one', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-rule-add'));
    await userEvent.type(screen.getByTestId('profile-rule-2-label'), 'Wholesale pricing');
    expect(await saved()).toEqual({
      escalationRules: [
        { label: 'Asks for a person', type: 'keyword', value: 'human', enabled: true },
        { label: 'Order over 1000', enabled: false },
        { label: 'Wholesale pricing', enabled: true },
      ],
    });
  });

  it('★ edit: the reworded rule keeps its type and value; the switched one is sent switched', async () => {
    profile();
    const label = screen.getByTestId('profile-rule-0-label');
    await userEvent.clear(label);
    await userEvent.type(label, 'Asks for a human');
    await userEvent.click(screen.getByTestId('profile-rule-1-on'));
    expect(await saved()).toEqual({
      escalationRules: [
        { label: 'Asks for a human', type: 'keyword', value: 'human', enabled: true },
        { label: 'Order over 1000', enabled: true },
      ],
    });
  });

  it('★ remove: the rest, without it', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-rule-0-remove'));
    expect(screen.queryByTestId('profile-rule-1')).toBeNull();
    expect(await saved()).toEqual({
      escalationRules: [{ label: 'Order over 1000', enabled: false }],
    });
  });

  it('remove them all: an empty array, and the page says there are none', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-rule-1-remove'));
    await userEvent.click(screen.getByTestId('profile-rule-0-remove'));
    expect(screen.getByTestId('profile-rules-none')).toHaveTextContent('No conditions yet.');
    expect(await saved()).toEqual({ escalationRules: [] });
  });

  it('a condition with no words holds Save and says why', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-rule-add'));
    expect(screen.getByTestId('profile-rules-problem')).toHaveTextContent(
      'Every condition needs words. Write them, or remove it.',
    );
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('profile-rule-2-label'), 'x');
    expect(screen.queryByTestId('profile-rules-problem')).toBeNull();
    expect(screen.getByTestId('profile-save')).toBeEnabled();
  });

  it('fifty: no Add, and the line that says it is the most', () => {
    profile({
      escalationRules: Array.from({ length: 50 }, (_, i) => ({ label: `r${i}`, enabled: true })),
    });
    expect(screen.queryByTestId('profile-rule-add')).toBeNull();
    expect(screen.getByTestId('profile-rules-full')).toHaveTextContent(
      '50 conditions, the most it keeps.',
    );
  });
});

describe('★ Save: asks first, sends only what changed, says what the route refused', () => {
  it('the confirmation names each change, then one PATCH and a fresh read', async () => {
    profile();
    await userEvent.click(screen.getByTestId('profile-tone-formal'));
    await userEvent.click(screen.getByTestId('profile-system-woocommerce-on'));
    await userEvent.click(screen.getByTestId('profile-save'));
    expect(screen.getByTestId('profile-confirm-changes')).toHaveTextContent(
      /Its tone.*The business systems it may use/,
    );
    await userEvent.click(screen.getByTestId('profile-confirm-save'));
    expect(save.mock.calls[0]![1]).toEqual({
      tone: 'formal',
      integrationAccess: ['shopify', 'woocommerce'],
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refused rule list says so, in the dialog, and nothing is refreshed', async () => {
    save.mockResolvedValue({ ok: false, reason: 'invalid_rules' });
    profile();
    await userEvent.click(screen.getByTestId('profile-rule-0-remove'));
    await userEvent.click(screen.getByTestId('profile-save'));
    await userEvent.click(screen.getByTestId('profile-confirm-save'));
    expect(await screen.findByTestId('profile-save-failed')).toHaveTextContent(
      "A condition couldn't be saved: each needs words, up to 300 characters.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('★ a switch’s words toggle it (dev, 2026-10-13)', () => {
  it('"Says it’s AI when asked": pressing the words, not only the switch', async () => {
    profile();
    const before = (screen.getByTestId('profile-discloses') as HTMLInputElement).checked;
    await userEvent.click(screen.getByTestId('profile-discloses-says'));
    expect((screen.getByTestId('profile-discloses') as HTMLInputElement).checked).toBe(!before);
  });

  it('a business system: pressing its name', async () => {
    profile();
    await userEvent.click(screen.getByText('WooCommerce'));
    expect(screen.getByTestId('profile-system-woocommerce-on')).toBeChecked();
  });
});

describe('★★ E4 (2026-10-14) - "Limits": its own rules, saved with the rest', () => {
  const RULES = { customGuardrails: ['Never discuss competitors', 'Never promise a date'] };

  it('★ the stored rules, each its own words; add, reword and remove go out as ONE whole list', async () => {
    profile(RULES);
    expect(screen.getByTestId('profile-limits')).toHaveTextContent('Limits');
    expect(screen.getByTestId('profile-limit-0-text')).toHaveValue('Never discuss competitors');
    await userEvent.click(screen.getByTestId('profile-limit-1-remove'));
    const text0 = screen.getByTestId('profile-limit-0-text');
    await userEvent.clear(text0);
    await userEvent.type(text0, 'Never name a competitor');
    await userEvent.click(screen.getByTestId('profile-limit-add'));
    await userEvent.type(screen.getByTestId('profile-limit-1-text'), '  Always sign as Maya ');
    expect(screen.getByTestId('profile-changes')).toHaveTextContent('1 change');
    expect(await saved()).toEqual({
      customGuardrails: ['Never name a competitor', 'Always sign as Maya'],
    });
  });

  it('★★ every rule removed sends [] - it clears them', async () => {
    profile({ customGuardrails: ['Only one'] });
    await userEvent.click(screen.getByTestId('profile-limit-0-remove'));
    expect(screen.getByTestId('profile-limits-none')).toHaveTextContent('No rules yet.');
    expect(await saved()).toEqual({ customGuardrails: [] });
  });

  it('★★ unread rules: said, nothing to edit, never sent', async () => {
    profile({ customGuardrails: 'a string' });
    expect(screen.getByTestId('profile-limits-unread')).toHaveTextContent("couldn't be read");
    expect(screen.queryByTestId('profile-limit-add')).toBeNull();
    await userEvent.click(screen.getByTestId('profile-tone-formal'));
    expect(await saved()).toEqual({ tone: 'formal' });
  });

  it('a rule with no words, or over 280, cannot be saved - and says why', async () => {
    profile(RULES);
    await userEvent.click(screen.getByTestId('profile-limit-add'));
    expect(screen.getByTestId('profile-limits-problem')).toHaveTextContent(
      'Every rule needs words',
    );
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    expect(screen.getByTestId('profile-limit-2-text')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByTestId('profile-limit-2-text'), {
      target: { value: 'x'.repeat(281) },
    });
    expect(screen.getByTestId('profile-limits-problem')).toHaveTextContent(
      'A rule can be up to 280 characters.',
    );
    expect(screen.getByTestId('profile-save')).toBeDisabled();
  });

  it('20 rules: no "Add", and it says so', () => {
    profile({ customGuardrails: Array.from({ length: 20 }, (_, i) => `Rule ${i}`) });
    expect(screen.queryByTestId('profile-limit-add')).toBeNull();
    expect(screen.getByTestId('profile-limits-full')).toHaveTextContent('20 rules');
  });

  it('★★ refused by the server: which rule, marked in place - and an edit clears the mark', async () => {
    save.mockResolvedValue({
      ok: false,
      reason: 'invalid_limits',
      why: 'too_long',
      max: 280,
      index: 1,
    });
    profile(RULES);
    await userEvent.type(screen.getByTestId('profile-limit-1-text'), '!');
    await userEvent.click(screen.getByTestId('profile-save'));
    await userEvent.click(await screen.findByTestId('profile-confirm-save'));
    expect(await screen.findByTestId('profile-save-failed')).toHaveTextContent(
      'Rule 2 is too long: up to 280 characters.',
    );
    expect(screen.getByTestId('profile-limit-1-text')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('profile-limit-0-text')).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await userEvent.type(screen.getByTestId('profile-limit-0-text'), '.');
    expect(screen.getByTestId('profile-limit-1-text')).not.toHaveAttribute('aria-invalid');
  });

  it('Hebrew: מגבלות, and a refusal in its words', async () => {
    save.mockResolvedValue({
      ok: false,
      reason: 'invalid_limits',
      why: 'too_many',
      max: 20,
      index: null,
    });
    profile(RULES, {}, 'he');
    expect(screen.getByTestId('profile-limits')).toHaveTextContent('מגבלות');
    await userEvent.type(screen.getByTestId('profile-limit-0-text'), '!');
    await userEvent.click(screen.getByTestId('profile-save'));
    await userEvent.click(await screen.findByTestId('profile-confirm-save'));
    expect(await screen.findByTestId('profile-save-failed')).toHaveTextContent('עד 20 כללים.');
  });
});
