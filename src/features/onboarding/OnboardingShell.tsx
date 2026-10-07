import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { ONBOARDING_STEPS, type OnboardingStep } from '@/api/contracts/onboarding';
import { Logo } from '@/design-system/brand/Logo';
import { Link } from '@/i18n/navigation';

import styles from './Onboarding.module.css';
import { stepHref } from './preview';

/**
 * 00d-00h's frame (design 6): a dark column - the mark, five steps (done ✓,
 * this one, the rest), the step's serif headline and its line, a status at
 * the foot - beside the light surface the step works on.
 *
 * Source of truth carries "Most important" on every step, as the design does.
 *
 * ★ In preview (`?preview=1`) the steps are links - each step's own way on
 *   is a write, drawn as a status there - and a line above the work says
 *   what this is, with the way back Home.
 */
export function OnboardingShell({
  step,
  preview = false,
  children,
}: {
  readonly step: OnboardingStep;
  /** A live workspace's admin, walking it read-only. */
  readonly preview?: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('onboarding');
  const here = ONBOARDING_STEPS.indexOf(step);
  return (
    <div className={styles.frame}>
      <aside className={styles.column}>
        <span className={styles.brand}>
          <Logo variant="framed" size={26} />
          GOTCHA
        </span>
        <ol className={styles.steps} aria-label={t('stepsLabel')}>
          {ONBOARDING_STEPS.map((name, i) => (
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
              {preview && i !== here ? (
                <Link
                  href={stepHref(`/onboarding/${name}`, true)}
                  className={styles.stepName}
                  data-testid={`onboarding-step-link-${name}`}
                >
                  {t(`steps.${name}`)}
                </Link>
              ) : (
                <span className={styles.stepName}>{t(`steps.${name}`)}</span>
              )}
              {name === 'truth' ? (
                <span className={styles.important}>{t('mostImportant')}</span>
              ) : null}
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
        <div className={styles.work}>
          {preview ? (
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
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}
