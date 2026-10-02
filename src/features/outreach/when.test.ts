import { createFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { campaignWhen } from './when';

const format = createFormatter({ locale: 'en', timeZone: 'UTC' });
const NOW = new Date('2026-10-02T12:00:00.000Z');

describe('★★ a campaign’s moment as 02 writes one', () => {
  it('⚠⚠ 24-hour — never "4:18 PM"', () => {
    const text = campaignWhen('2026-10-07T16:18:00.000Z', NOW, format)!;
    expect(text).toMatch(/16:18/);
    expect(text).not.toMatch(/AM|PM/);
  });

  it('★ within the week, a weekday — 02’s "Thursday 10:00"', () => {
    expect(campaignWhen('2026-10-01T10:00:00.000Z', NOW, format)).toMatch(/^Thursday,? 10:00$/);
  });

  it('★ beyond it, a date — and no year that is this year’s', () => {
    const text = campaignWhen('2026-10-20T09:30:00.000Z', NOW, format)!;
    expect(text).toMatch(/Oct/);
    expect(text).not.toMatch(/2026/);
  });

  it('but the year when it is another one', () => {
    expect(campaignWhen('2027-01-05T09:30:00.000Z', NOW, format)).toMatch(/2027/);
  });

  it('nothing for a moment we do not have, or cannot read', () => {
    expect(campaignWhen(null, NOW, format)).toBeNull();
    expect(campaignWhen('not-a-date', NOW, format)).toBeNull();
  });
});
