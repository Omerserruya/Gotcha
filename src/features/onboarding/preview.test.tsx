import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { integrationSchema } from '@/api/contracts/integrations';
import {
  discoverySchema,
  previewAnswerSchema,
  previewQuestionsSchema,
} from '@/api/contracts/onboarding';
import { workspaceVoiceSchema } from '@/api/contracts/workspace';
import capabilitiesMessages from '@/i18n/messages/en/capabilities.json';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';
import workspaceMessages from '@/i18n/messages/en/workspace.json';

/** An href as the browser would get it: a string, or pathname?query. */
const hrefOf = (href: unknown) => {
  if (typeof href === 'string') return href;
  const { pathname, query } = href as { pathname: string; query?: Record<string, string> };
  const q = new URLSearchParams(query ?? {}).toString();
  return q ? `${pathname}?${q}` : pathname;
};
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={hrefOf(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  startReading: vi.fn(),
  readReading: vi.fn(),
  teachAnswer: vi.fn(),
  finishOnboarding: vi.fn(),
  askPreview: vi.fn(),
}));
vi.mock('./onboarding-actions', () => actions);
const voiceActions = vi.hoisted(() => ({
  saveWorkspaceVoice: vi.fn(),
  previewVoiceSample: vi.fn(),
}));
vi.mock('@/features/workspace/actions', () => voiceActions);
vi.mock('@/features/capabilities/connect-actions', () => ({
  connectIntegration: vi.fn(),
  startOAuth: vi.fn(),
  startWooOAuth: vi.fn(),
}));
vi.mock('@/features/capabilities/shopify-actions', () => ({
  startShopifyInstall: vi.fn(),
  claimShopifyInstall: vi.fn(),
  verifyShopifyBilling: vi.fn(),
}));

const { LearnedStep } = await import('./LearnedStep');
const { OnboardingShell } = await import('./OnboardingShell');
const { ReadingStep } = await import('./ReadingStep');
const { TruthStep } = await import('./TruthStep');
const { TryStep } = await import('./TryStep');
const { WebsiteStep } = await import('./WebsiteStep');
const { isPreview, stepHref } = await import('./preview');

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{
        onboarding: onboardingMessages,
        capabilities: capabilitiesMessages,
        workspace: workspaceMessages,
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );

/** The uniform unavailable look: a status, not something to press. */
const isStatus = (el: HTMLElement) => {
  expect(el.tagName).not.toBe('BUTTON');
  expect(el).toHaveAttribute('aria-disabled', 'true');
  expect(el).toHaveTextContent('Preview');
};

/** Every link inside, as hrefs. */
const links = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);

const stepLinks = (root: HTMLElement) => links(root).filter((h) => h.startsWith('/onboarding'));

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(voiceActions)]) fn.mockReset();
});

describe('stepHref', () => {
  it('carries the flag only when previewing, beside what the link already says', () => {
    expect(stepHref('/onboarding/try', false)).toBe('/onboarding/try');
    expect(stepHref('/onboarding/try', true)).toEqual({
      pathname: '/onboarding/try',
      query: { preview: '1' },
    });
    expect(stepHref('/onboarding/truth', true, { system: 'wix' })).toEqual({
      pathname: '/onboarding/truth',
      query: { system: 'wix', preview: '1' },
    });
    expect(isPreview({ preview: '1' })).toBe(true);
    expect(isPreview({ preview: 'true' })).toBe(false);
    expect(isPreview(undefined)).toBe(false);
  });
});

describe('★★ the shell in preview: says what it is, Home one click away, the steps are links', () => {
  it('previewing', () => {
    const { container } = wrap(
      <OnboardingShell step="learned" preview>
        <p>work</p>
      </OnboardingShell>,
    );
    expect(screen.getByTestId('onboarding-preview')).toHaveTextContent('nothing here changes it');
    expect(screen.getByTestId('onboarding-preview-home')).toHaveAttribute('href', '/home');
    // One frame with the step, so the banner is the column's width (dev: it ran past it).
    expect(screen.getByTestId('onboarding-preview').parentElement).toBe(
      screen.getByText('work').parentElement,
    );
    // Every other step a link that stays a preview; this one is where you are.
    expect(stepLinks(container).sort()).toEqual(
      ['website', 'reading', 'truth', 'try'].map((s) => `/onboarding/${s}?preview=1`).sort(),
    );
  });

  it('not previewing: none of it', () => {
    const { container } = wrap(
      <OnboardingShell step="learned">
        <p>work</p>
      </OnboardingShell>,
    );
    expect(screen.queryByTestId('onboarding-preview')).toBeNull();
    expect(stepLinks(container)).toEqual([]);
  });
});

describe('★★ each step in preview: every write a status, every step link still a preview', () => {
  it('00d: "Yes, read it" and "Read this one" are statuses, and nothing starts', () => {
    wrap(
      <WebsiteStep
        guess={{ host: 'avivco.il', from: 'email' }}
        email="maya@avivco.il"
        business="Aviv & Co."
        discovery={null}
        preview
      />,
    );
    isStatus(screen.getByTestId('website-yes'));
    fireEvent.click(screen.getByTestId('website-yes'));
    fireEvent.click(screen.getByTestId('website-different'));
    isStatus(screen.getByTestId('website-read'));
    fireEvent.change(screen.getByTestId('website-address'), {
      target: { value: 'other.co.il' },
    });
    fireEvent.submit(screen.getByTestId('website-address').closest('form')!);
    expect(actions.startReading).not.toHaveBeenCalled();
  });

  it('00e: its links stay previews', () => {
    const done = discoverySchema.parse({
      websiteDomain: 'https://avivco.il',
      status: 'COMPLETE',
      updatedAt: '2026-10-06T10:00:05.000Z',
    });
    const { container } = wrap(
      <ReadingStep initial={{ discovery: done, facts: [] }} since={null} preview />,
    );
    expect(stepLinks(container)).toEqual(['/onboarding/learned?preview=1']);
  });

  it('00f: saving the voice is a status; the sample (a read) still asks; its links stay previews', async () => {
    voiceActions.previewVoiceSample.mockResolvedValue({ ok: true, reply: 'Hi Dana!' });
    const { container } = wrap(
      <LearnedStep
        discovery={discoverySchema.parse({ status: 'COMPLETE' })}
        facts={[]}
        voice={workspaceVoiceSchema.parse({
          guidance: 'Warm and short. First names, no emoji, never Dear customer.',
          source: 'learned',
        })}
        preview
      />,
    );
    expect(stepLinks(container).sort()).toEqual([
      '/onboarding/truth?preview=1',
      '/onboarding/website?preview=1',
    ]);
    fireEvent.click(screen.getByTestId('voice-adjust'));
    isStatus(screen.getByTestId('voice-save'));
    fireEvent.click(screen.getByTestId('voice-save'));
    expect(voiceActions.saveWorkspaceVoice).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-ask'));
    });
    expect(voiceActions.previewVoiceSample).toHaveBeenCalled();
  });

  it('00g: no connect of any kind - a status; tiles and the way on stay previews', () => {
    const shopify = integrationSchema.parse({
      id: 'i-shopify',
      slug: 'shopify',
      name: 'Shopify',
      authType: 'OAUTH2',
      authSchema: { oauth: true, fields: [] },
      tenantConnection: null,
    });
    const { container } = wrap(
      <TruthStep
        integrations={[shopify]}
        shopify={{ mode: 'listing', helpUrl: null }}
        detected={{ slug: 'shopify', host: 'avivco.il' }}
        system={null}
        coreSystem={null}
        preview
      />,
    );
    const card = screen.getByTestId('truth-preview');
    isStatus(card.firstElementChild as HTMLElement);
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('shopify-start')).toBeNull();
    const hrefs = stepLinks(container);
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) expect(href).toContain('preview=1');
  });

  it('00h: asking still answers; Fix is a status; the finish is "Back to Home" and never /complete', async () => {
    actions.askPreview.mockResolvedValue({
      ok: true,
      answer: previewAnswerSchema.parse({
        data: { answer: 'We do.', grounded: true, sources: [] },
      }).data,
    });
    const questions = previewQuestionsSchema.parse({
      data: { real: [{ question: 'Do you deliver to Eilat?', askCount: 2 }], suggested: [] },
    }).data;
    wrap(<TryStep questions={questions} skippedCore={false} preview />);
    expect(screen.queryByTestId('try-open')).toBeNull();
    expect(screen.getByTestId('try-home')).toHaveAttribute('href', '/home');
    expect(screen.getByTestId('try-home')).toHaveTextContent('Back to Home');
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-real-0-see'));
    });
    expect(screen.getByTestId('try-real-0-answer')).toHaveTextContent('We do.');
    isStatus(screen.getByTestId('try-real-0-fix'));
    fireEvent.click(screen.getByTestId('try-real-0-fix'));
    expect(screen.queryByTestId('try-real-0-fix-text')).toBeNull();
    expect(actions.finishOnboarding).not.toHaveBeenCalled();
    expect(actions.teachAnswer).not.toHaveBeenCalled();
  });
});

describe('★ sweep: every step link in the onboarding components goes through stepHref', () => {
  /*
   * ★ Granularity: by line, in this folder's components, for a `/onboarding`
   *   literal. A link built elsewhere, or from a variable, is not seen; the
   *   renders above are what check the ones that exist.
   */
  it('no `/onboarding` path written outside stepHref', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'src/features/onboarding');
    const bare = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ at: `${f}:${i + 1}`, line })),
      )
      .filter(({ line }) => /['"`]\/onboarding/.test(line) && !line.includes('stepHref('))
      .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    expect(bare.map((b) => b.at)).toEqual([]);
  });
});

describe("★★ the banner is exactly the step column's width - and the column keeps its own", () => {
  /*
   * jsdom does no layout, so this reads the values that decide it. The first
   * fix passed its own check here (fit-content + contain) while on dev it
   * matched the banner to the column by SHRINKING the column, 1235 → 1058.
   * So the rule now: each step's width is set once, as --step-width by step,
   * and both the step and the preview frame read it. A browser measurement
   * is still the real check.
   */
  const css = async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(
      join(process.cwd(), 'src/features/onboarding/Onboarding.module.css'),
      'utf8',
    );
  };
  const block = (all: string, selector: string) =>
    new RegExp(`${selector.replace(/[.[\]'=]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(all)?.[1] ??
    '';

  it('the frame takes the step width, never fit-content', async () => {
    const all = await css();
    expect(block(all, '.previewFrame')).toMatch(/max-inline-size:\s*var\(--step-width\)/);
    expect(block(all, '.previewFrame')).not.toMatch(/fit-content/);
  });

  it.each([
    ['reading', '620px'],
    ['learned', '800px'],
    ['truth', '680px'],
    ['try', '660px'],
  ])('%s: its width is set once, and the step reads it', async (step, width) => {
    const all = await css();
    expect(block(all, `.work[data-step='${step}']`)).toMatch(
      new RegExp(`--step-width:\\s*${width}`),
    );
    expect(block(all, `.${step}`)).toMatch(/max-inline-size:\s*var\(--step-width\)/);
  });

  it('the shell names the step on the work area', () => {
    const { container } = wrap(
      <OnboardingShell step="try" preview>
        <p>work</p>
      </OnboardingShell>,
    );
    expect(container.querySelector('[data-step="try"]')).not.toBeNull();
  });
});
