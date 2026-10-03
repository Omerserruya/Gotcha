'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { STEP_TYPES } from '@/api/contracts/automations';
import hire from '@/features/employees/hire/Hire.module.css';
import { Link } from '@/i18n/navigation';

import styles from './NewAutomation.module.css';

type StepType = (typeof STEP_TYPES)[number];

/**
 * 21, measured: "New automation" — Hire's 1000 sheet over 09. A sentence in
 * a dark bar, WHEN and THEN under it, what it would have caught, how to
 * start it, and Save.
 *
 * Read-only, as Hire is. What is local: the sentence, the WHEN (the flow's
 * `trigger` is free text), and the THEN — steps added from the runner's own
 * node types (`STEP_TYPES`) and removed. The body Save would send is
 * `POST /api/chatbot-flows` `{ name, trigger, nodes, edges }`, the steps
 * chained in order.
 *
 * ── DRAWN, AND WHY ──
 *   Build it             nothing turns a sentence into steps
 *   each step's settings a node's message, target or field — not drawn
 *   last month           nothing replays past conversations against a rule
 *   Watch it for a week  no watch-only mode: a flow is on or off
 *   Save automation      writes a flow — waiting for approval
 *   Test on a past one   the same missing replay
 */
export function NewAutomation() {
  const t = useTranslations('automations.createSheet');
  const ts = useTranslations('automations.step');
  const td = useTranslations('automations.detail');
  const [sentence, setSentence] = useState('');
  const [when, setWhen] = useState('');
  const [steps, setSteps] = useState<readonly StepType[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={hire.layer} data-testid="new-automation">
      <Link
        href="/studio/automations"
        className={hire.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section className={hire.sheet} aria-label={t('title')}>
        <header className={hire.head}>
          <div className={hire.titles}>
            <h2 className={hire.title}>{t('title')}</h2>
            <p className={hire.line}>{t('line')}</p>
          </div>
          <Link
            href="/studio/automations"
            className={hire.close}
            aria-label={t('close')}
            scroll={false}
          >
            <X size={16} aria-hidden="true" />
          </Link>
        </header>

        <div className={styles.describe}>
          <div className={styles.bar}>
            <textarea
              className={styles.sentence}
              rows={1}
              value={sentence}
              placeholder={t('sentencePlaceholder')}
              aria-label={t('sentenceLabel')}
              data-testid="new-sentence"
              onChange={(e) => setSentence(e.target.value)}
            />
            <span
              role="button"
              className={styles.build}
              aria-disabled="true"
              title={t('buildNone')}
              data-testid="new-build"
            >
              {t('build')}
            </span>
          </div>
        </div>

        <div className={styles.body}>
          <section className={styles.rule}>
            <div className={styles.part}>
              <span className={styles.label}>{td('when')}</span>
              <input
                className={styles.step}
                value={when}
                placeholder={t('whenPlaceholder')}
                aria-label={td('when')}
                data-testid="new-when"
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
            <div className={styles.part}>
              <span className={styles.label}>{td('then')}</span>
              <ol className={styles.steps} data-testid="new-steps">
                {steps.map((type, i) => (
                  <li key={i} className={styles.step} data-testid={`new-step-${i}`}>
                    <span className={styles.stepName}>{ts(type)}</span>
                    <span className={styles.stepMeta} title={t('settingsNone')}>
                      —
                    </span>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={t('remove', { step: ts(type) })}
                      data-testid={`new-remove-${i}`}
                      onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
                <li className={styles.adder}>
                  <button
                    type="button"
                    className={styles.add}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-testid="new-add"
                    onClick={() => setMenuOpen(!menuOpen)}
                  >
                    {t('addLong')}
                  </button>
                  {menuOpen ? (
                    <ul className={styles.menu} role="menu" aria-label={t('add')}>
                      {STEP_TYPES.map((type) => (
                        <li key={type} role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className={styles.menuItem}
                            data-testid={`new-add-${type}`}
                            onClick={() => {
                              setSteps([...steps, type]);
                              setMenuOpen(false);
                            }}
                          >
                            {ts(type)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              </ol>
            </div>
          </section>

          <div className={styles.cards}>
            <section className={styles.caught} data-testid="new-caught">
              <h3 className={styles.caughtTitle}>{t('caught')}</h3>
              <p className={styles.caughtBody} title={t('caughtNone')}>
                —
              </p>
            </section>
            <section className={styles.start}>
              <h3 className={styles.startTitle}>{t('start')}</h3>
              <div className={styles.options} role="radiogroup" aria-label={t('start')}>
                <span
                  role="radio"
                  aria-checked="false"
                  aria-disabled="true"
                  className={styles.option}
                  title={t('watchNone')}
                  data-testid="new-watch"
                >
                  <span className={styles.dot} />
                  {t('watch')}
                </span>
                <span
                  role="radio"
                  aria-checked="true"
                  className={styles.option}
                  data-testid="new-on"
                >
                  <span className={styles.dot} />
                  {t('on')}
                </span>
              </div>
            </section>
          </div>

          <div className={styles.foot}>
            <span
              role="button"
              className={styles.save}
              aria-disabled="true"
              title={t('saveNotYet')}
              data-testid="new-save"
            >
              {t('save')}
            </span>
            <span
              role="button"
              className={styles.test}
              aria-disabled="true"
              title={t('caughtNone')}
              data-testid="new-test"
            >
              {t('test')}
            </span>
            <Link href="/studio/automations" className={styles.cancel} scroll={false}>
              {t('cancel')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
