'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { SkillMode, ToolChoice } from '@/api/contracts/skills';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { Link, useRouter } from '@/i18n/navigation';

import { giveSkill, createSkill, saveSkill, type SaveResult } from './skill-actions';
import { blankDraft, bodyOf, draftProblems, type SkillDraft } from './skill-draft';
import { SkillForm } from './SkillForm';
import { avatarTone, employeeInitials } from './skill-words';
import styles from './NewSkill.module.css';

export interface Employee {
  readonly id: string;
  readonly name: string;
  readonly role: string | null;
}

/**
 * 21 - New skill (design 6), over 09.
 *
 * ★ NO SENTENCE-TO-SKILL YET. The prompt bar is drawn and says so; the
 *   skill is written in the form below it - the same fields GOTCHA would
 *   fill (decided with the supervisor, 2026-10-06). The backtest and "Test on
 *   a past conversation" are the next phase, drawn with their reason.
 *
 * Save is three real writes, in order:
 *   1  POST - a draft, version 1. A draft runs nowhere, not even in watch.
 *   2  given to anyone → PUT `status: active`
 *   3  each employee's list, with this skill in the chosen start mode
 * A failure at 2 or 3 leaves a saved draft, and says for whom it did not start.
 */
export function NewSkill({
  employees,
  tools,
  otherSkills,
}: {
  /** `null`: unread. */
  readonly employees: readonly Employee[] | null;
  readonly tools: readonly ToolChoice[] | null;
  readonly otherSkills: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('skills');
  const router = useRouter();
  const [draft, setDraft] = useState<SkillDraft>(blankDraft);
  const [given, setGiven] = useState<ReadonlySet<string>>(new Set());
  const [start, setStart] = useState<Exclude<SkillMode, 'off'>>('watch');
  const [result, setResult] = useState<SaveResult | null>(null);
  const [partly, setPartly] = useState<readonly string[]>([]);
  const [shown, setShown] = useState(false);
  const [isPending, startTransition] = useTransition();

  const problems = draftProblems(draft);
  const errors = new Map<string, string>(
    shown ? problems.map((p) => [p.field, t(`form.problems.${p.code}`)]) : [],
  );
  if (result && !result.ok && result.reason === 'invalid' && result.field) {
    errors.set(result.field, result.error || t('new.failed.invalid'));
  }

  const close = () => router.replace('/studio/skills', { scroll: false });
  /** Saved, but not started for everyone: Save again would make a second skill. */
  const [savedId, setSavedId] = useState<string | null>(null);

  const save = () => {
    setShown(true);
    if (problems.length > 0) return;
    setResult(null);
    setPartly([]);
    startTransition(async () => {
      const created = await createSkill(bodyOf(draft));
      setResult(created);
      if (!created.ok) return;
      const id = created.skill.id;
      const chosen = (employees ?? []).filter((e) => given.has(e.id));
      const missed: string[] = [];
      if (chosen.length > 0) {
        const active = await saveSkill(id, { status: 'active' });
        if (!active.ok) missed.push(...chosen.map((e) => e.name));
        else {
          for (const employee of chosen) {
            if ((await giveSkill(employee.id, id, start)) === null) missed.push(employee.name);
          }
        }
      }
      if (missed.length > 0) {
        setPartly(missed);
        setSavedId(id);
        return;
      }
      router.push(`/studio/skills/${id}`);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : close())}>
      <DialogContent
        title={t('new.title')}
        hideTitle
        // The visible subtitle is the description (one, not a second unstyled copy).
        aria-describedby="new-skill-subtitle"
        className={styles.sheet}
        data-testid="new-skill"
      >
        <header className={styles.head} aria-hidden="true">
          <span>
            <span className={styles.title}>{t('new.title')}</span>
            <span className={styles.subtitle} id="new-skill-subtitle">
              {t('new.description')}
            </span>
          </span>
        </header>
        <button
          type="button"
          className={styles.close}
          onClick={close}
          aria-label={t('new.close')}
          data-testid="new-skill-close"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <div className={styles.body}>
          <div className={styles.prompt}>
            <span className={styles.promptDot} aria-hidden="true" />
            <span className={styles.promptText}>{t('new.prompt')}</span>
            <button
              type="button"
              className={styles.writeIt}
              disabled
              title={t('new.writeItWhy')}
              data-testid="new-skill-write-it"
            >
              {t('new.writeIt')}
            </button>
          </div>

          <div className={styles.columns}>
            <SkillForm
              draft={draft}
              onChange={setDraft}
              tools={tools}
              otherSkills={otherSkills}
              errors={errors}
              newId={() => crypto.randomUUID()}
            />

            <div className={styles.side}>
              <section className={styles.card} data-testid="new-skill-backtest">
                <h3 className={styles.eyebrow}>{t('new.backtest.title')}</h3>
                <p className={styles.quiet}>{t('new.backtest.why')}</p>
              </section>

              <section className={styles.card} data-testid="new-skill-give">
                <h3 className={styles.eyebrow}>{t('new.giveTo')}</h3>
                {employees === null ? (
                  <p className={styles.quiet}>{t('new.employeesUnread')}</p>
                ) : employees.length === 0 ? (
                  <p className={styles.quiet}>{t('new.noEmployees')}</p>
                ) : (
                  <ul className={styles.people}>
                    {employees.map((employee) => (
                      <li key={employee.id} className={styles.person}>
                        <span className={styles.avatar} data-tone={avatarTone(employee.id)}>
                          {employeeInitials(employee.name)}
                        </span>
                        <span className={styles.personName}>{employee.name}</span>
                        <input
                          type="checkbox"
                          role="switch"
                          className={styles.switch}
                          checked={given.has(employee.id)}
                          onChange={(e) => {
                            const next = new Set(given);
                            if (e.target.checked) next.add(employee.id);
                            else next.delete(employee.id);
                            setGiven(next);
                          }}
                          aria-label={employee.name}
                          data-testid={`new-skill-give-${employee.id}`}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <fieldset className={styles.card} data-testid="new-skill-start">
                <legend className={styles.eyebrow}>{t('new.start.title')}</legend>
                {(['watch', 'on'] as const).map((mode) => (
                  <label key={mode} className={styles.radio}>
                    <input
                      type="radio"
                      name="start"
                      value={mode}
                      checked={start === mode}
                      onChange={() => setStart(mode)}
                      data-testid={`new-skill-start-${mode}`}
                    />
                    {t(`new.start.${mode}`)}
                  </label>
                ))}
              </fieldset>
            </div>
          </div>
        </div>

        <footer className={styles.foot}>
          {savedId ? (
            <Link
              href={`/studio/skills/${savedId}`}
              className={styles.save}
              data-testid="new-skill-open"
            >
              {t('new.open')}
            </Link>
          ) : (
            <button
              type="button"
              className={styles.save}
              onClick={save}
              disabled={isPending}
              data-testid="new-skill-save"
            >
              {isPending ? t('new.saving') : t('new.save')}
            </button>
          )}
          <button
            type="button"
            className={styles.secondary}
            disabled
            title={t('new.testWhy')}
            data-testid="new-skill-test"
          >
            {t('new.test')}
          </button>
          {result && !result.ok ? (
            <p className={styles.problem} role="alert" data-testid="new-skill-problem">
              {t(`new.failed.${result.reason}`)}
            </p>
          ) : partly.length > 0 ? (
            <p className={styles.problem} role="alert" data-testid="new-skill-partly">
              {t('new.partly', { names: partly.join(', ') })}
            </p>
          ) : null}
          <button type="button" className={styles.cancel} onClick={close}>
            {t('new.cancel')}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
