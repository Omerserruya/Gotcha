import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { ONBOARDING_STEPS, type OnboardingStep } from '@/api/contracts/onboarding';
import { Logo } from '@/design-system/brand/Logo';

import styles from './Onboarding.module.css';

/**
 * 00d-00h's frame (design 6): a dark column - the mark, five steps (done ✓,
 * this one, the rest), the step's serif headline and its line, a status at
 * the foot - beside the light surface the step works on.
 *
 * Source of truth carries "Most important" on every step, as the design does.
 */
export function OnboardingShell({
  step,
  children,
}: {
  readonly step: OnboardingStep;
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
              <span className={styles.stepName}>{t(`steps.${name}`)}</span>
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
        <div className={styles.work}>{children}</div>
      </main>
    </div>
  );
}
