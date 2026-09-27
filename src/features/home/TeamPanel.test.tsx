import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { AgentPresence } from '@/api/contracts/presence';
import en from '@/i18n/messages/en/home.json';
import he from '@/i18n/messages/he/home.json';

import { TeamPanel } from './TeamPanel';

/**
 * "Away until 11:00" — in the page's language, not the server's.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS IS A UNIT TEST AND NOT A SCREENSHOT
 * ════════════════════════════════════════════════════════════════════════════
 * The defect only renders when somebody is AWAY with an `awayUntil` set, and
 * the demo tenant may have nobody away. **A clean Hebrew shot of screen 01
 * would not mean the formatter is fixed — it would mean the branch was never
 * exercised**, which is the distinction this project has now made in nine
 * different places.
 *
 * So the branch is pinned here, where the state is ours to supply.
 *
 * ── THE DEFECT ──
 * `secondLine` called `until.toLocaleTimeString(undefined, …)` in a SERVER
 * component. `undefined` resolves to the Node process's locale — `en-US` on
 * this machine, and whatever `LANG` a container is started with in general —
 * for every reader in every language. On a Hebrew page it printed `02:30 PM`
 * beside `14:30` times drawn through `getFormatter()` elsewhere on the same
 * screen.
 *
 * And it would not have been read as a bug. A 12-hour clock next to 24-hour
 * ones inside one Hebrew screenshot looks like an inconsistent design, and it
 * would have been filed against this panel and possibly designed around.
 */

const locales = {
  en: { messages: en, timeZone: 'Asia/Jerusalem' },
  he: { messages: he, timeZone: 'Asia/Jerusalem' },
} as const;

let current: 'en' | 'he' = 'en';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'home.team') =>
    createTranslator({
      locale: current,
      messages: { home: locales[current].messages },
      namespace,
    }),
  getFormatter: async () =>
    createFormatter({ locale: current, timeZone: locales[current].timeZone }),
}));

/* `TeamPanel` links to the people screen; the router is not what is under
   test here. Same shim as `FirstSteps.test.tsx`. */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const team = [{ agentId: 'u1', name: 'Dana', activeConversations: 0, claimedToday: 0 }];

/** 14:30 Jerusalem time, which is 02:30 PM on a 12-hour clock. */
const AWAY_UNTIL = '2026-09-27T11:30:00.000Z';

const away = (): ReadonlyMap<string, AgentPresence> =>
  new Map([['u1', { agentId: 'u1', status: 'AWAY', awayUntil: AWAY_UNTIL } as AgentPresence]]);

const show = async (locale: 'en' | 'he') => {
  current = locale;
  return render(await TeamPanel({ team, presence: away() }));
};

describe('★★ the away time follows the page, not the process', () => {
  it('★★ Hebrew gets a 24-hour clock, never 02:30 PM', async () => {
    /*
     * THE ASSERTION THAT WOULD HAVE CAUGHT IT. `he-IL` has no AM/PM, so the
     * presence of those letters is the defect itself rather than a proxy for
     * it — and `14:30` is what every other time on that screen shows.
     */
    await show('he');

    const row = screen.getByText(/חוזר ב-/);
    expect(row).toHaveTextContent(/14:30/);
    expect(row).not.toHaveTextContent(/AM|PM/);
  });

  it('English gets its own conventions, from the same call', async () => {
    // Not asserting 12-hour here: what `en-US` does with `hour: '2-digit'` is
    // next-intl's business. What matters is that the locale reaching the
    // formatter is the PAGE's, and Hebrew above proves that.
    await show('en');
    expect(screen.getByText(/Away until/)).toBeInTheDocument();
  });

  it('★ a member with no away time is described by load instead', async () => {
    // The branch that renders when the one above does not — so a test failing
    // on the clock cannot be passed by removing the sentence.
    current = 'he';
    render(
      await TeamPanel({
        team,
        presence: new Map([['u1', { agentId: 'u1', status: 'ONLINE' } as AgentPresence]]),
      }),
    );
    expect(screen.queryByText(/חוזר ב-/)).toBeNull();
  });
});
