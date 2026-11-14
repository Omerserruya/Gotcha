import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import onboardingEn from '@/i18n/messages/en/onboarding.json';
import capabilitiesHe from '@/i18n/messages/he/capabilities.json';
import onboardingHe from '@/i18n/messages/he/onboarding.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { OnboardingShell } from './OnboardingShell';

const show = (props: Partial<Parameters<typeof OnboardingShell>[0]> = {}, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{ onboarding: he ? onboardingHe : onboardingEn }}
    >
      <OnboardingShell step="systems" screen="systems" {...props}>
        <p>work</p>
      </OnboardingShell>
    </NextIntlClientProvider>,
  );

describe('★★ the column: four steps', () => {
  it('★★ learn, systems, channels, live; this one is current, the ones before done', () => {
    show();
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((li) => li.getAttribute('data-testid'))).toEqual([
      'onboarding-step-learn',
      'onboarding-step-systems',
      'onboarding-step-channels',
      'onboarding-step-live',
    ]);
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'here',
      'later',
      'later',
    ]);
  });

  it('★★ no "Most important" tag: systems can be skipped', () => {
    show();
    expect(screen.getByRole('list')).not.toHaveTextContent(/most important/i);
    expect(JSON.stringify(onboardingHe)).not.toContain('הכי חשוב');
  });

  it('★★ the one-line step for a phone: "Step 2 of 4: Connect systems"', () => {
    show();
    expect(screen.getByTestId('onboarding-step-compact')).toHaveTextContent(
      'Step 2 of 4: Connect systems',
    );
  });

  it('Hebrew', () => {
    show({ step: 'learn', screen: 'reading' }, true);
    expect(screen.getByTestId('onboarding-step-compact')).toHaveTextContent(
      'שלב 1 מתוך 4: לומדים את האתר',
    );
  });

  it('★ the work area takes the SCREEN, not the step (each screen sets its own width)', () => {
    const { container } = show({ step: 'learn', screen: 'reading' });
    expect(container.querySelector('[data-step="reading"]')).not.toBeNull();
  });

  it('★ in preview, every other step is a link that stays a preview', () => {
    show({ preview: true });
    for (const name of ['learn', 'channels', 'live']) {
      expect(screen.getByTestId(`onboarding-step-link-${name}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('onboarding-step-link-systems')).toBeNull();
  });
});

describe('★★ the way back (Omer, 2026-10-24: there was none)', () => {
  it.each([
    ['systems', '/onboarding/reading'],
    ['channels', '/onboarding/systems'],
    ['live', '/onboarding/channels'],
  ] as const)('%s goes back to %s', (step, href) => {
    show({ step, screen: step });
    const back = screen.getByTestId('onboarding-back');
    expect(back).toHaveAttribute('href', href);
    expect(back).toHaveTextContent('Back to the previous step');
  });

  it('★ the first stop for the keyboard: one Tab reaches it', async () => {
    show({ step: 'systems', screen: 'systems' });
    await userEvent.tab();
    expect(screen.getByTestId('onboarding-back')).toHaveFocus();
  });

  it('step 1 has none: nothing comes before the website', () => {
    show({ step: 'learn', screen: 'reading' });
    expect(screen.queryByTestId('onboarding-back')).toBeNull();
  });

  it('in preview it stays a preview', () => {
    show({ step: 'channels', screen: 'channels', preview: true });
    expect(JSON.parse(screen.getByTestId('onboarding-back').getAttribute('href') ?? '')).toEqual({
      pathname: '/onboarding/systems',
      query: { preview: '1' },
    });
  });

  it('in Hebrew', () => {
    show({ step: 'live', screen: 'live' }, true);
    expect(screen.getByTestId('onboarding-back')).toHaveTextContent('חזרה לשלב הקודם');
  });
});

describe('★★ CSS: the phone shows the one line; Hebrew is never letter-spaced', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/features/onboarding/Onboarding.module.css'),
    'utf8',
  );

  const rule = (selector: string, within = css) =>
    new RegExp(`\\n {2,4}${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(within)?.[1] ?? '';

  it('★★ on a desktop only the work surface scrolls: the frame is the window, the column stays', () => {
    const desktop = css.slice(0, css.indexOf('@media (width <= 1000px)'));
    expect(rule('.frame', desktop)).toMatch(/\bblock-size:\s*100dvh;/);
    expect(rule('.frame', desktop)).not.toMatch(/min-block-size/);
    expect(rule('.surface', desktop)).toMatch(/overflow-y:\s*auto;/);
    expect(rule('.surface', desktop)).toMatch(/min-block-size:\s*0;/);
    // Centred, and a step taller than the panel is never cut off above it.
    expect(rule('.work', desktop)).toMatch(/justify-content:\s*safe center;/);
  });

  it('below 1000px the page scrolls again: the column is one line', () => {
    const media = css.slice(css.indexOf('@media (width <= 1000px)'));
    expect(rule('.frame', media)).toMatch(/block-size:\s*auto;/);
    expect(rule('.surface', media)).toMatch(/overflow-y:\s*visible;/);
  });

  it('below 1000px: the list and the foot hide, the one line shows', () => {
    const media = css.slice(css.indexOf('@media (width <= 1000px)'));
    expect(media).toMatch(/\.steps,\s*\.foot\s*\{\s*display:\s*none;/);
    expect(media).toMatch(/\.compactStep\s*\{\s*display:\s*block;/);
  });

  it('★★ :lang(he) sets letter-spacing to normal on every rule that spaces letters, the Latin brand aside', () => {
    const spaced = [
      ...css.matchAll(/\n {2}\.([\w-]+)[^{\n]*\{[^}]*letter-spacing:\s*(?!normal)[^;]+;/g),
    ]
      .map((m) => m[1])
      .filter((name) => name !== 'brand');
    const he =
      /:root:lang\(he\) :is\(([^)]*(?:\)[^)]*)*)\)\s*\{\s*letter-spacing:\s*normal;/.exec(
        css,
      )?.[1] ?? '';
    for (const name of new Set(spaced)) expect(he).toContain(`.${name}`);
  });
});

describe('★★ no maqaf in the Hebrew onboarding catalogue (Omer, 2026-10-24)', () => {
  // By code point: the character this guard forbids is never typed here.
  const MAQAF = String.fromCharCode(0x05be);

  it('he/onboarding.json has none: U+2011 before Latin or a digit, nothing before Hebrew', () => {
    const at = JSON.stringify(onboardingHe)
      .split(MAQAF)
      .slice(0, -1)
      .map((before) => before.slice(-12));
    expect(at).toEqual([]);
  });

  it('a plural that can say a Hebrew word joins it directly: "לחודש אחד", "ל‑12 חודשים"', () => {
    const t = createTranslator({ locale: 'he', messages: { onboarding: onboardingHe } });
    const key = 'onboarding.review.terms.warranty' as never;
    expect(t(key, { months: 1 } as never)).toBe('אחריות לחודש אחד');
    expect(t(key, { months: 12 } as never)).toBe('אחריות ל\u201112 חודשים');
  });
});

describe('★★ one way of addressing the owner: plural, everywhere onboarding speaks', () => {
  // The screens say "שלכם"; a "יחזיר אותך" beside them reads as another voice.
  const SINGULAR =
    /(?<![\u05d0-\u05ea])(אותך|שלך|לך|אליך|עליך|ממך|בשבילך|איתך|תוכל|תוכלי|תצטרך|אתה)(?![\u05d0-\u05ea])/;
  const strings = (value: unknown, at = ''): [string, string][] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => strings(inner, `${at}.${key}`))
      : typeof value === 'string'
        ? [[at, value]]
        : [];
  const shown = {
    onboarding: onboardingHe,
    // The connect launchers onboarding's step 2 draws.
    capabilities: {
      shopify: capabilitiesHe.shopify,
      woo: capabilitiesHe.woo,
      oauth: capabilitiesHe.oauth,
      available: capabilitiesHe.available,
      fieldLabels: capabilitiesHe.fieldLabels,
    },
  };

  it.each(strings(shown))('%s', (_, text) => {
    expect(text).not.toMatch(SINGULAR);
  });
});
