import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/security.json';
import he from '@/i18n/messages/he/security.json';

vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(), getLocale: vi.fn() }));

import { auditCsv, csvCell, parseCsvLine } from './audit-csv';

const make = (locale: 'en' | 'he', names = new Map<string, string>()) =>
  auditCsv({
    t: createTranslator({
      locale,
      messages: { security: locale === 'en' ? en : he },
      namespace: 'security',
    }) as never,
    locale,
    timeZone: 'Asia/Jerusalem',
    names,
  });
const cells = (line: string) => parseCsvLine(line);

describe('★★ 16’s export, readable: the screen’s words first, the platform’s columns after', () => {
  it('parses the platform’s CSV: quoted cells, doubled quotes, empty cells', () => {
    expect(parseCsvLine('"2026-10-08T09:00:00.000Z","ai.responded","ai",,,,')).toEqual([
      '2026-10-08T09:00:00.000Z',
      'ai.responded',
      'ai',
      '',
      '',
      '',
      '',
    ]);
    expect(parseCsvLine('"a ""b"", c",d')).toEqual(['a "b", c', 'd']);
  });

  it('the header, in the reader’s language, then the raw columns', () => {
    expect(cells(make('en').header())).toEqual([
      'When',
      'What happened',
      'By',
      'About',
      'Worked',
      'timestamp',
      'action',
      'actor_type',
      'actor_id',
      'target_type',
      'target_id',
      'succeeded',
    ]);
    expect(cells(make('he').header()).slice(0, 5)).toEqual([
      'מתי',
      'מה קרה',
      'על ידי',
      'על מה',
      'הצליח',
    ]);
  });

  it('★ "ai.responded","ai",,,, reads as the screen does - and nothing recorded is said', () => {
    const row = cells(
      make('en').row([
        '2026-10-08T09:05:07.000Z',
        'ai.responded',
        'ai',
        '',
        'conversation',
        'c1',
        '',
      ]),
    );
    expect(row[0]).toBe('10/08/2026, 12:05:07');
    expect(row[1]).toMatch(/^GOTCHA /);
    expect(row[2]).toBe('GOTCHA');
    expect(row[3]).toBe('A conversation');
    expect(row[4]).toBe('Not recorded');
    // The platform's columns, unchanged.
    expect(row.slice(5)).toEqual([
      '2026-10-08T09:05:07.000Z',
      'ai.responded',
      'ai',
      '',
      'conversation',
      'c1',
      '',
    ]);
  });

  it('a failed lookup (the adapter’s err) is "No"; a recorded true is "Yes"', () => {
    const csv = make('en');
    expect(
      cells(
        csv.row([
          '2026-10-08T09:00:00Z',
          'adapter.err.shopify.get_customer_by_phone',
          'ai',
          '',
          '',
          '',
          '',
        ]),
      )[4],
    ).toBe('No');
    expect(
      cells(
        csv.row(['2026-10-08T09:00:00Z', 'ai.paused_for_approval', 'ai', '', '', '', 'true']),
      )[4],
    ).toBe('Yes');
  });

  it('by: a person by name from the team read; "system" as an id, or no read, is the word for a person', () => {
    const csv = make('en', new Map([['u1', 'Maya Cohen']]));
    expect(
      cells(csv.row(['2026-10-08T09:00:00Z', 'message.sent', 'user', 'u1', '', '', '']))[2],
    ).toBe('Maya Cohen');
    expect(
      cells(csv.row(['2026-10-08T09:00:00Z', 'message.sent', 'user', 'system', '', '', '']))[2],
    ).toBe('Someone on your team');
    expect(cells(csv.row(['2026-10-08T09:00:00Z', 'x', 'system', '', '', '', '']))[2]).toBe(
      'The system',
    );
  });

  it('the same row in Hebrew differs - which is right', () => {
    const row = ['2026-10-08T09:00:00Z', 'ai.responded', 'ai', '', '', '', ''];
    expect(make('he').row(row)).not.toBe(make('en').row(row));
    expect(cells(make('he').row(row))[4]).toBe('לא נרשם');
  });

  it('the platform’s "EXPORT FAILED" marker stays a said line, never read as a row', () => {
    const row = cells(
      make('en').row(['EXPORT FAILED - this file is incomplete', '', '', '', '', '', '']),
    );
    expect(row[0]).toBe('The export stopped here - this file is incomplete');
  });

  it('a value a spreadsheet would run is led by an apostrophe', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('Maya')).toBe('"Maya"');
  });
});

describe('★★ Hebrew: GOTCHA is feminine, the system too; a person keeps the slash; objects in Hebrew', () => {
  const what = (action: string, actorType = 'ai') =>
    cells(make('he').row(['2026-10-08T09:00:00Z', action, actorType, '', '', '', '']))[1];

  it('GOTCHA ענתה, חיפשה לקוח לפי טלפון - never "ענה/תה", "חיפש/ה"', () => {
    expect(what('ai.responded')).toBe('GOTCHA ענתה ללקוח');
    expect(what('adapter.err.shopify.get_customer_by_phone')).toBe(
      'GOTCHA חיפשה לקוח לפי טלפון ב־Shopify',
    );
    expect(what('adapter.ok.shopify.get_customer_orders')).toBe(
      'GOTCHA חיפשה הזמנות של לקוח ב־Shopify',
    );
    expect(what('adapter.ok.shopify.list_products')).toBe('GOTCHA הציגה מוצרים ב־Shopify');
    expect(what('ai.paused_for_approval')).toBe('GOTCHA עצרה וביקשה אישור');
  });

  it('the system is feminine; someone on the team keeps the slash', () => {
    expect(what('message.sent', 'system')).toBe('המערכת שלחה הודעה');
    expect(what('message.sent', 'user')).toBe('מישהו בצוות שלח/ה הודעה');
  });

  it('an operation the catalogue does not know is its own words - never raw', () => {
    expect(what('adapter.ok.shopify.get_loyalty_points')).toBe(
      'GOTCHA חיפשה loyalty points ב־Shopify',
    );
  });

  it('★ every sentence with GOTCHA as the actor: no slash anywhere', () => {
    const actions = [
      'ai.responded',
      'message.sent',
      'ai.bot_turn',
      'ai.paused_for_approval',
      'ai.tool_call.escalate_to_human',
      'billing.provisioning_attempted',
      'billing.provisioning_request_created',
      ...[
        'get',
        'search',
        'update',
        'process',
        'summarize',
        'create',
        'cancel',
        'list',
        'export',
      ].map((verb) => `adapter.ok.shopify.${verb}_order`),
    ];
    for (const action of actions) expect(what(action), action).not.toMatch(/\//);
  });
});
