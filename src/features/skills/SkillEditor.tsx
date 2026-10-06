'use client';

import { ChevronRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { humanizeTag } from '@/api/contracts/approvals';
import { skillStatus, type Skill, type SkillRun, type ToolChoice } from '@/api/contracts/skills';
import { Link } from '@/i18n/navigation';

import { giveSkill, readRuns, saveSkill, type SaveResult } from './skill-actions';
import { bodyOf, draftOf, draftProblems, type SkillDraft } from './skill-draft';
import { SkillForm } from './SkillForm';
import { avatarTone, employeeInitials } from './skill-words';
import type { Employee } from './NewSkill';
import styles from './SkillEditor.module.css';

/**
 * 09b - Edit a skill (design 6).
 *
 *   header   Skills › name, its standing; Run log; Save (PUT - every save is
 *            a new version, step ids sent back so a run in progress keeps its
 *            place)
 *   left     the skill, written (`SkillForm`)
 *   right    Used by - a switch per employee, written at once; the test
 *            panel, or the run log in its place
 *
 * ★ "USED BY" WRITES THE EMPLOYEE'S LIST. A skill given here starts in
 *   Watch (design: new skills watch first); On / Watch / Off per employee is
 *   07g's. A draft runs nowhere, so giving one makes it active first.
 * ★ The live test is the next phase: drawn, saying so, with the real 7-day
 *   numbers under it.
 */
export function SkillEditor({
  skill: initial,
  employees,
  tools,
  otherSkills,
}: {
  readonly skill: Skill;
  readonly employees: readonly Employee[] | null;
  readonly tools: readonly ToolChoice[] | null;
  readonly otherSkills: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('skills');
  const format = useFormatter();
  const [skill, setSkill] = useState(initial);
  const [draft, setDraft] = useState<SkillDraft>(() => draftOf(initial));
  const [shown, setShown] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [carried, setCarried] = useState<ReadonlyMap<string, string>>(
    () => new Map((initial.stats?.usedBy ?? []).map((u) => [u.aiAgentId, u.mode])),
  );
  const [giving, setGiving] = useState<string | null>(null);
  const [giveFailed, setGiveFailed] = useState<string | null>(null);
  const [log, setLog] = useState<
    | {
        readonly runs: readonly SkillRun[];
        readonly nextCursor: string | null;
      }
    | null
    | 'reading'
    | 'failed'
  >(null);
  const [isSaving, startSave] = useTransition();
  const [, startGive] = useTransition();

  const problems = draftProblems(draft);
  const errors = new Map<string, string>(
    shown ? problems.map((p) => [p.field, t(`form.problems.${p.code}`)]) : [],
  );
  if (result && !result.ok && result.reason === 'invalid' && result.field) {
    errors.set(result.field, result.error || t('new.failed.invalid'));
  }
  const dirty = JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(draftOf(skill)));
  const status = skillStatus({
    ...skill,
    stats: skill.stats
      ? {
          ...skill.stats,
          usedBy: [...carried].map(([aiAgentId, mode], order) => ({
            aiAgentId,
            name: '',
            mode: mode as 'on' | 'watch' | 'off',
            order,
          })),
        }
      : null,
  });

  const save = () => {
    setShown(true);
    if (problems.length > 0) return;
    setResult(null);
    startSave(async () => {
      const saved = await saveSkill(skill.id, bodyOf(draft));
      setResult(saved);
      if (saved.ok) {
        setSkill({ ...saved.skill, stats: saved.skill.stats ?? skill.stats });
        setDraft(draftOf(saved.skill));
        setShown(false);
      }
    });
  };

  const give = (employee: Employee, on: boolean) => {
    setGiving(employee.id);
    setGiveFailed(null);
    startGive(async () => {
      if (on && skill.status === 'draft') {
        const active = await saveSkill(skill.id, { status: 'active' });
        if (!active.ok) {
          setGiveFailed(employee.id);
          setGiving(null);
          return;
        }
        setSkill({ ...active.skill, stats: active.skill.stats ?? skill.stats });
      }
      const list = await giveSkill(employee.id, skill.id, on ? 'watch' : null);
      if (list === null) setGiveFailed(employee.id);
      else {
        const row = list.skills.find((s) => s.skillId === skill.id);
        const next = new Map(carried);
        if (row) next.set(employee.id, row.mode);
        else next.delete(employee.id);
        setCarried(next);
      }
      setGiving(null);
    });
  };

  const openLog = (cursor: string | null) => {
    if (cursor === null) setLog('reading');
    startGive(async () => {
      const page = await readRuns(skill.id, cursor);
      if (page === null) setLog('failed');
      else
        setLog((now) =>
          cursor && now && typeof now === 'object'
            ? { runs: [...now.runs, ...page.runs], nextCursor: page.nextCursor }
            : page,
        );
    });
  };

  const stats = skill.stats;

  return (
    <div className={styles.editor}>
      <header className={styles.bar}>
        <nav className={styles.crumbs} aria-label={t('editor.crumbs')}>
          <Link href="/studio/skills" className={styles.crumb}>
            {t('title')}
          </Link>
          <ChevronRight size={14} aria-hidden="true" className={styles.crumbArrow} />
          <h1 className={styles.name}>
            <bdi dir="auto">{skill.name}</bdi>
          </h1>
          <span className={styles.chip} data-standing={status} data-testid="skill-standing">
            {status === 'live' ? <span className={styles.dot} aria-hidden="true" /> : null}
            {t(`standing.${status}`)}
          </span>
          <span className={styles.version} data-testid="skill-version">
            {t('editor.version', { version: skill.version })}
          </span>
        </nav>
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            aria-pressed={log !== null}
            onClick={() => (log === null ? openLog(null) : setLog(null))}
            data-testid="skill-run-log"
          >
            {t('editor.runLog')}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={save}
            disabled={isSaving || !dirty}
            title={dirty ? undefined : t('editor.nothingToSave')}
            data-testid="skill-save"
          >
            {isSaving ? t('new.saving') : t('editor.save')}
          </button>
        </span>
      </header>
      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid="skill-save-problem">
          {t(`new.failed.${result.reason}`)}
        </p>
      ) : result?.ok ? (
        <p className={styles.saved} role="status" data-testid="skill-saved">
          {t('editor.saved', { version: result.skill.version })}
        </p>
      ) : null}

      <div className={styles.columns}>
        <SkillForm
          draft={draft}
          onChange={setDraft}
          tools={tools}
          otherSkills={otherSkills.filter((s) => s.id !== skill.id)}
          errors={errors}
          newId={() => crypto.randomUUID()}
        />

        <div className={styles.side}>
          <section className={styles.card} data-testid="skill-used-by">
            <h2 className={styles.eyebrow}>{t('editor.usedBy')}</h2>
            {employees === null ? (
              <p className={styles.quiet}>{t('new.employeesUnread')}</p>
            ) : employees.length === 0 ? (
              <p className={styles.quiet}>{t('new.noEmployees')}</p>
            ) : (
              <ul className={styles.people}>
                {employees.map((employee) => {
                  const mode = carried.get(employee.id);
                  const on = mode !== undefined && mode !== 'off';
                  return (
                    <li key={employee.id} className={styles.person}>
                      <span className={styles.avatar} data-tone={avatarTone(employee.id)}>
                        {employeeInitials(employee.name)}
                      </span>
                      <span className={styles.personText}>
                        <span className={styles.personName}>
                          {employee.name}
                          {mode === 'watch' ? (
                            <span className={styles.watchTag}>{t('editor.mode.watch')}</span>
                          ) : null}
                        </span>
                        <span className={styles.quiet}>
                          {giveFailed === employee.id
                            ? t('editor.giveFailed')
                            : (employee.role ?? '')}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        className={styles.switch}
                        checked={on}
                        disabled={giving !== null}
                        onChange={(e) => give(employee, e.target.checked)}
                        aria-label={employee.name}
                        title={on ? undefined : t('editor.startsWatching')}
                        data-testid={`skill-give-${employee.id}`}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {log === null ? (
            <section className={styles.test} data-testid="skill-test">
              <h2 className={styles.testTitle}>
                <span className={styles.testDot} aria-hidden="true" />
                {t('editor.test')}
                <span className={styles.sandbox}>{t('editor.sandbox')}</span>
              </h2>
              <p className={styles.testWhy}>{t('editor.testWhy')}</p>
              <p className={styles.testStats} data-testid="skill-week-stats">
                {stats === null
                  ? t('editor.statsUnread')
                  : stats.runs === 0
                    ? t('editor.statsNone')
                    : t('editor.stats', {
                        runs: stats.runs,
                        // A share of FINISHED runs: multiplied by all runs it would invent a count.
                        alone:
                          stats.aloneShare === null
                            ? '-'
                            : format.number(stats.aloneShare, { style: 'percent' }),
                        asked: stats.askedYou,
                      })}
              </p>
            </section>
          ) : (
            <section className={styles.card} data-testid="skill-log">
              <h2 className={styles.eyebrow}>{t('editor.runLog')}</h2>
              {log === 'reading' ? (
                <p className={styles.quiet}>{t('editor.logReading')}</p>
              ) : log === 'failed' ? (
                <p className={styles.quiet}>{t('editor.logFailed')}</p>
              ) : log.runs.length === 0 ? (
                <p className={styles.quiet}>{t('editor.logEmpty')}</p>
              ) : (
                <ol className={styles.runs}>
                  {log.runs.map((run) => (
                    <li key={run.id} className={styles.run} data-testid={`skill-run-${run.id}`}>
                      <span className={styles.runTop}>
                        <span className={styles.runStatus} data-status={run.status}>
                          {t(`editor.runStatus.${run.status}`)}
                        </span>
                        {run.mode === 'watch' ? (
                          <span className={styles.quiet}>{t('editor.mode.watch')}</span>
                        ) : null}
                        <span className={styles.quiet}>
                          {run.startedAt
                            ? format.dateTime(new Date(run.startedAt), {
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                                hourCycle: 'h23',
                              })
                            : '-'}
                        </span>
                      </span>
                      <span className={styles.quiet}>
                        {t('editor.runSteps', {
                          count: run.trace.length,
                          version: run.skillVersion,
                        })}
                        {run.stopReason ? ` · ${humanizeTag(run.stopReason)}` : ''}
                      </span>
                      {run.conversationId ? (
                        <Link
                          href={{ pathname: '/inbox', query: { c: run.conversationId } }}
                          className={styles.runLink}
                        >
                          {t('editor.openConversation')}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {log && typeof log === 'object' && log.nextCursor ? (
                <button
                  type="button"
                  className={styles.more}
                  onClick={() => openLog(log.nextCursor)}
                  data-testid="skill-log-more"
                >
                  {t('editor.logMore')}
                </button>
              ) : null}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
