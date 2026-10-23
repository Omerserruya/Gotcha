import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { SHELL_STEPS, type ShellStep } from '@/api/contracts/onboarding-v2';
import { Logo } from '@/design-system/brand/Logo';
import { Link } from '@/i18n/navigation';

import styles from './Onboarding.module.css';
import { stepHref } from './preview';

/** Where each step starts, as a preview link; `null` while that step has no screen yet. */
const STEP_HREF: Readonly<Record<ShellStep, (() => ReturnType<typeof stepHref>) | null>> = {
  learn: () => stepHref('/onboarding/website', true),
  systems: () => stepHref('/onboarding/systems', true),
  channels: null,
  live: () => stepHref('/onboarding/learned', true),
};

/**
 * 00d-00h's frame (design 6): a dark column - the mark, the four steps of
 * onboarding v2 (done ✓, this one, the rest), the step's serif headline and
 * its line, a status at the foot - beside the light surface the step works on.
 *
 * ★ No "Most important" tag any more: connecting systems can be skipped,
 *   and a tag on a skippable step says the opposite of its button.
 * ★ On a phone the column is one line ("step 1 of 4: ...") so the step's
 *   own work - the live feed above all - is on the first screen.
 *
 * ★ In preview (`?preview=1`) the steps are links - each step's own way on
 *   is a write, drawn as a status there - and a line above the work says
 *   what this is, with the way back Home.
 */
export function OnboardingShell({
  step,
  screen,
  preview = false,
  children,
}: {
  readonly step: ShellStep;
  /** The screen within the step (website, reading, systems...): it sets the work area's width. */
  readonly screen: string;
  /** A live workspace's admin, walking it read-only. */
  readonly preview?: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('onboarding');
  const here = SHELL_STEPS.indexOf(step);
  return (
    <div className={styles.frame}>
      <aside className={styles.column}>
        <span className={styles.brand}>
          <Logo variant="framed" size={26} />
          GOTCHA
        </span>
        <p className={styles.compactStep} data-testid="onboarding-step-compact">
          {t('stepOf', { n: here + 1, total: SHELL_STEPS.length, name: t(`steps.${step}`) })}
        </p>
        <ol className={styles.steps} aria-label={t('stepsLabel')}>
          {SHELL_STEPS.map((name, i) => (
            <li
              key={name}
              className={styles.step}
              data-state={i < here ? 'done' : i === here ? 'here' : 'later'}
              aria-current={i === here ? 'step' : undefined}
              data-testid={`onboarding-step-${name}`}
            >
              <span className={styles.stepMark} aria-hidden="true">
                {i < here ? <Check size={11} strokeWidth={2.5} /> : i + 1}
              </span>
              {preview && i !== here && STEP_HREF[name] ? (
                <Link
                  href={STEP_HREF[name]()}
                  className={styles.stepName}
                  data-testid={`onboarding-step-link-${name}`}
                >
                  {t(`steps.${name}`)}
                </Link>
              ) : (
                <span className={styles.stepName}>{t(`steps.${name}`)}</span>
              )}
            </li>
          ))}
        </ol>
        <div className={styles.pitch}>
          <p className={styles.headline}>{t(`${step}.headline`)}</p>
          <p className={styles.lead}>{t(`${step}.lead`)}</p>
        </div>
        <p className={styles.foot}>
          <span className={styles.footDot} aria-hidden="true" />
          {t(`${step}.foot`)}
        </p>
      </aside>
      <main className={styles.surface}>
        <div className={styles.work} data-step={screen}>
          {preview ? (
            // The step's own width (--step-width), so the banner is the column's.
            <div className={styles.previewFrame}>
              <p className={styles.previewBanner} role="status" data-testid="onboarding-preview">
                <span>{t('preview.banner')}</span>
                <Link
                  href="/home"
                  className={styles.inlineLink}
                  data-testid="onboarding-preview-home"
                >
                  {t('preview.home')}
                </Link>
              </p>
              {children}
            </div>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}
