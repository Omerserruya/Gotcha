import { readFileSync } from 'node:fs';

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';
import he from '@/i18n/messages/he/workspace.json';

const { saveWorkspaceFacts } = vi.hoisted(() => ({ saveWorkspaceFacts: vi.fn() }));
vi.mock('./actions', () => ({ saveWorkspaceFacts }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { checkBusinessFact } from './BusinessFacts';
import { FactRows } from './FactRows';
import type { WebsiteScan } from './load-workspace';

/*
 * Reset here, not in the render helper: a resolved value set before a render
 * must survive it, and a call must not leak into the next test.
 */
beforeEach(() => {
  saveWorkspaceFacts.mockReset();
  saveWorkspaceFacts.mockResolvedValue({ ok: true, data: {} });
});

const UPDATED_AT = '2026-10-11T08:00:00.000Z';

const ws = (over: Record<string, unknown> = {}) =>
  workspaceSchema.parse({
    name: 'Urban Supply',
    description: 'Linen bedding',
    websiteDomain: 'https://www.urban-supply.com/',
    industry: 'ecommerce',
    country: 'IL',
    address: '14 Ha’arba’a, Tel Aviv',
    currency: 'USD',
    timezone: 'Europe/London',
    languages: ['he'],
    hours: null,
    updatedAt: UPDATED_AT,
    ...over,
  });

const renderRows = (over: Record<string, unknown> = {}, scan: WebsiteScan | null = null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <FactRows workspace={ws(over)} scan={scan} />
    </NextIntlClientProvider>,
  );

describe('★ one block: each business fact is on the page once (Omer, 2026-10-11)', () => {
  it('name, website, what you sell and address - one row each, one value each', () => {
    renderRows();
    for (const [key, value] of [
      ['name', 'Urban Supply'],
      ['website', 'urban-supply.com'],
      ['description', 'Linen bedding'],
      ['address', '14 Ha’arba’a, Tel Aviv'],
    ] as const) {
      expect(screen.getAllByTestId(`fact-${key}`)).toHaveLength(1);
      expect(screen.getAllByText(value)).toHaveLength(1);
    }
  });

  it('★ the duplicate is gone: nothing here opens a business drawer', () => {
    const { container } = renderRows();
    expect(container.innerHTML).not.toMatch(/panel=business|"panel":"business"/);
    expect(screen.queryByTestId('business-drawer')).toBeNull();
  });
});

describe('★ edit in place saves exactly that field, against the version drawn', () => {
  it.each([
    ['name', 'Urban Supply Co.', { name: 'Urban Supply Co.' }],
    ['description', 'Linen bedding and towels', { description: 'Linen bedding and towels' }],
    ['address', '  2 Dizengoff, Tel Aviv  ', { address: '2 Dizengoff, Tel Aviv' }],
  ] as const)('%s → that field alone, with If-Match', async (key, typed, patch) => {
    renderRows();
    await userEvent.click(screen.getByTestId(`fact-edit-${key}`));
    const input = screen.getByTestId(`fact-input-${key}`);
    await userEvent.clear(input);
    await userEvent.type(input, typed);
    await userEvent.click(screen.getByTestId(`fact-save-${key}`));
    expect(saveWorkspaceFacts).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceFacts).toHaveBeenCalledWith(patch, UPDATED_AT);
    expect(await screen.findByTestId(`fact-note-${key}`)).toHaveTextContent('Saved');
    expect(screen.queryByTestId(`fact-input-${key}`)).toBeNull();
  });

  it('an emptied address is cleared - null, which the route takes', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-address'));
    await userEvent.clear(screen.getByTestId('fact-input-address'));
    await userEvent.click(screen.getByTestId('fact-save-address'));
    expect(saveWorkspaceFacts).toHaveBeenCalledWith({ address: null }, UPDATED_AT);
  });

  it('nothing changed: still sent as it is, so the version check still runs', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.click(screen.getByTestId('fact-save-name'));
    expect(saveWorkspaceFacts).toHaveBeenCalledWith({ name: 'Urban Supply' }, UPDATED_AT);
  });

  it('★ someone else saved first: said in words, and the text is kept', async () => {
    saveWorkspaceFacts.mockResolvedValueOnce({ ok: false, reason: 'stale' });
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.type(screen.getByTestId('fact-input-name'), ' Co.');
    await userEvent.click(screen.getByTestId('fact-save-name'));
    expect(await screen.findByTestId('fact-problem-name')).toHaveTextContent(
      'Someone else saved this while you were editing.',
    );
    expect(screen.getByTestId('fact-input-name')).toHaveValue('Urban Supply Co.');
  });
});

describe('★ each field is checked as the route checks it, and refused in words', () => {
  it('the rule, beside the route’s: 1-200, 1-2000, 0-300 after trimming', () => {
    expect(checkBusinessFact('name', '   ')).toEqual({ ok: false, problem: 'required' });
    expect(checkBusinessFact('description', '')).toEqual({ ok: false, problem: 'required' });
    expect(checkBusinessFact('address', '  ')).toEqual({ ok: true, value: null });
    expect(checkBusinessFact('name', 'x'.repeat(200))).toEqual({
      ok: true,
      value: 'x'.repeat(200),
    });
    expect(checkBusinessFact('name', 'x'.repeat(201))).toMatchObject({
      problem: 'tooLong',
      max: 200,
    });
    expect(checkBusinessFact('description', 'x'.repeat(2001))).toMatchObject({ max: 2000 });
    expect(checkBusinessFact('address', 'x'.repeat(301))).toMatchObject({ max: 300 });
  });

  it('an empty name is refused before any request, in words', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.clear(screen.getByTestId('fact-input-name'));
    await userEvent.click(screen.getByTestId('fact-save-name'));
    expect(screen.getByTestId('fact-problem-name')).toHaveTextContent(
      "Your business name can't be empty.",
    );
    expect(screen.getByTestId('fact-input-name')).toHaveAttribute('aria-invalid', 'true');
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
  });

  it('too long: the limit and the count, not a silent cut', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-description'));
    fireEvent.change(screen.getByTestId('fact-input-description'), {
      target: { value: 'x'.repeat(2001) },
    });
    await userEvent.click(screen.getByTestId('fact-save-description'));
    expect(screen.getByTestId('fact-problem-description')).toHaveTextContent(
      '2000 characters at most. This has 2001.',
    );
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
  });

  it('the route refused the field anyway: our words, never its English', async () => {
    saveWorkspaceFacts.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid',
      fields: { address: 'address must be between 0 and 300 characters' },
    });
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-address'));
    await userEvent.type(screen.getByTestId('fact-input-address'), ' 3');
    await userEvent.click(screen.getByTestId('fact-save-address'));
    const problem = await screen.findByTestId('fact-problem-address');
    expect(problem).toHaveTextContent("This wasn't accepted. Check it and save again.");
    expect(problem).not.toHaveTextContent(/must be between/);
  });
});

describe('★ a field PATCH cannot save is not drawn as editable', () => {
  it.each(['website', 'industry', 'country'])(
    '%s: no Edit, no field, and a click does nothing',
    async (key) => {
      renderRows();
      const row = screen.getByTestId(`fact-${key}`);
      expect(screen.queryByTestId(`fact-edit-${key}`)).toBeNull();
      expect(within(row).queryByRole('button')).toBeNull();
      await userEvent.click(screen.getByTestId(`fact-value-${key}`));
      expect(within(row).queryByRole('textbox')).toBeNull();
      expect(saveWorkspaceFacts).not.toHaveBeenCalled();
    },
  );

  it('they are shown, by name, with why on their titles', () => {
    renderRows();
    expect(screen.getByTestId('fact-value-industry')).toHaveTextContent('E-commerce');
    expect(screen.getByTestId('fact-value-country')).toHaveTextContent('Israel');
    expect(screen.getByTestId('fact-value-industry')).toHaveAttribute(
      'title',
      expect.stringMatching(/can't be changed here/),
    );
    expect(screen.getByTestId('fact-value-website')).toHaveAttribute(
      'title',
      expect.stringMatching(/not here/),
    );
  });
});

describe('★ 11e’s keys: Enter saves, Esc cancels', () => {
  it('Enter in the field saves', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.type(screen.getByTestId('fact-input-name'), ' Co.{Enter}');
    expect(saveWorkspaceFacts).toHaveBeenCalledWith({ name: 'Urban Supply Co.' }, UPDATED_AT);
  });

  it('Esc cancels: nothing sent, the stored value back, focus on the row’s Edit', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.type(screen.getByTestId('fact-input-name'), ' Co.{Escape}');
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fact-input-name')).toBeNull();
    expect(screen.getByTestId('fact-value-name')).toHaveTextContent(/^Urban Supply$/);
    expect(screen.getByTestId('fact-edit-name')).toHaveFocus();
  });

  it('what you sell: Shift+Enter is a new line, not a save', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-description'));
    await userEvent.type(screen.getByTestId('fact-input-description'), '{Shift>}{Enter}{/Shift}');
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
    expect(screen.getByTestId('fact-input-description')).toHaveValue('Linen bedding\n');
  });

  it('Enter on Cancel cancels - it does not save', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.type(screen.getByTestId('fact-input-name'), ' Co.');
    screen.getByTestId('fact-cancel-name').focus();
    await userEvent.keyboard('{Enter}');
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fact-input-name')).toBeNull();
  });
});

describe('★ the whole row starts editing; its Edit is the one tab stop', () => {
  it.each(['name', 'description', 'address'])(
    '%s: a click on the value opens the field',
    async (key) => {
      renderRows();
      await userEvent.click(screen.getByTestId(`fact-value-${key}`));
      expect(screen.getByTestId(`fact-input-${key}`)).toHaveFocus();
    },
  );

  it('a click on the label opens it too', async () => {
    renderRows();
    await userEvent.click(within(screen.getByTestId('fact-address')).getByText('Address'));
    expect(screen.getByTestId('fact-input-address')).toBeInTheDocument();
  });

  it('one focusable per row, named with its row', () => {
    renderRows();
    for (const key of ['name', 'description', 'address']) {
      const row = screen.getByTestId(`fact-${key}`);
      // The row itself counts: a tabindex on it would be a second stop.
      const selector = 'button, a[href], input, textarea, select, [tabindex]';
      const focusable = [row, ...row.querySelectorAll(selector)].filter((el) =>
        el.matches(selector),
      );
      expect(focusable).toHaveLength(1);
    }
    expect(screen.getByTestId('fact-edit-address')).toHaveAccessibleName('Edit Address');
  });

  it('the keyboard reaches it and opens it', async () => {
    renderRows();
    screen.getByTestId('fact-edit-description').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('fact-input-description')).toHaveFocus();
  });

  it('★ focus is drawn on the row, inside the card', () => {
    const css = readFileSync('src/features/workspace/Workspace.module.css', 'utf8');
    expect(css).toMatch(
      /\.rowEditable:has\(\.edit:focus-visible\)\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--border-focus\)/,
    );
  });
});

describe('★ the website row: what the scan read, what else it found, and Scan again', () => {
  const scan: WebsiteScan = {
    pagesRead: 42,
    daysAgo: 3,
    topics: ['products', 'shipping'],
    alsoFound: [
      { kind: 'store', name: 'Shopify' },
      { kind: 'channel', name: 'Instagram' },
    ],
  };

  it('"42 pages read 3 days ago" with its topics; "Also found" as chips', () => {
    renderRows({}, scan);
    expect(screen.getByTestId('business-scan-line')).toHaveTextContent(
      '42 pages read 3 days ago · products, shipping',
    );
    expect(screen.getByTestId('business-also-found')).toHaveTextContent(
      'Also foundShopify storeInstagram',
    );
    // The value itself stays the domain alone.
    expect(screen.getByTestId('fact-value-website')).toHaveTextContent(/^urban-supply\.com$/);
  });

  it('Scan again leads to Studio · Knowledge, where the rescan lives', () => {
    renderRows({}, scan);
    const again = screen.getByTestId('business-scan-again').getAttribute('href') ?? '';
    expect(again).toContain('/studio/knowledge');
    expect(again).toContain('scan');
  });

  it('nothing read: no line and no chips - never "0 pages read"', () => {
    renderRows({}, { ...scan, pagesRead: 0, alsoFound: [] });
    expect(screen.queryByTestId('business-scan-line')).toBeNull();
    expect(screen.queryByTestId('business-also-found')).toBeNull();
  });

  it('no website: why that matters, and nothing to scan again', () => {
    renderRows({ websiteDomain: null }, scan);
    expect(screen.getByTestId('fact-caveat-website')).toHaveTextContent(/nothing to scan/i);
    expect(screen.queryByTestId('business-scan-again')).toBeNull();
    expect(screen.queryByTestId('business-scan-line')).toBeNull();
  });
});

describe('★ Hebrew: the block’s own words', () => {
  it('the hint and the refusal in Hebrew', async () => {
    render(
      <NextIntlClientProvider locale="he" messages={{ workspace: he }}>
        <FactRows workspace={ws()} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    expect(screen.getByTestId('fact-name')).toHaveTextContent('שמירה ב‑Enter, ביטול ב‑Esc.');
    await userEvent.clear(screen.getByTestId('fact-input-name'));
    await userEvent.click(screen.getByTestId('fact-save-name'));
    expect(screen.getByTestId('fact-problem-name')).toHaveTextContent('שם העסק לא יכול להיות ריק.');
  });
});

describe('★ "From your website" says what it means - the banner’s sentence, on the chip', () => {
  const marked = {
    fieldSources: {
      organizationName: 'scan',
      businessDescription: 'scan',
      address: 'scan',
      industry: 'scan',
      country: 'scan',
      primaryLanguage: 'scan',
    },
  };
  const withSite =
    'Most of this was filled in from urban-supply.com when you signed up. Scanning again only updates fields marked “From your website”.';

  it('its title and its accessible description, on every marked row', () => {
    renderRows(marked);
    for (const key of ['name', 'description', 'address', 'industry', 'country', 'language']) {
      const chip = screen.getByTestId(`fact-origin-${key}`);
      expect(chip).toHaveTextContent(/^From your website$/);
      expect(chip).toHaveAttribute('title', withSite);
      expect(chip).toHaveAccessibleDescription(withSite);
      // Named, not only inferred from the title (which a computation falls back to).
      const described = document.getElementById(chip.getAttribute('aria-describedby') ?? '');
      expect(described).toHaveTextContent(withSite);
    }
  });

  it('no website stored: the same words without one', () => {
    renderRows({ ...marked, websiteDomain: null });
    const chip = screen.getByTestId('fact-origin-name');
    const noSite =
      'Most of this was filled in when you signed up. Scanning again only updates fields marked “From your website”.';
    expect(chip).toHaveAttribute('title', noSite);
    expect(chip).toHaveAccessibleDescription(noSite);
  });

  it('Hebrew: the banner’s Hebrew words', () => {
    render(
      <NextIntlClientProvider locale="he" messages={{ workspace: he }}>
        <FactRows workspace={ws(marked)} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('fact-origin-description')).toHaveAccessibleDescription(
      'רוב הפרטים האלה מולאו מ‑urban-supply.com כשנרשמתם. סריקה חוזרת מעדכנת רק שדות המסומנים „מהאתר שלכם”.',
    );
  });

  it('read once: the description is not also on the page as text', () => {
    renderRows(marked);
    const copies = screen.getAllByText(withSite);
    expect(copies).toHaveLength(6);
    for (const copy of copies) expect(copy).not.toBeVisible();
  });
});
