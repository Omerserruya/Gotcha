'use client';

import { GripVertical, Info, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type DragEvent, type ReactNode } from 'react';

import { humanizeTag } from '@/api/contracts/approvals';
import {
  NO_SKILL_POLICIES,
  type EmployeeSkills as Assigned,
  type NoSkillPolicy,
  type Skill,
  type SkillFit,
  type SkillMode,
} from '@/api/contracts/skills';
import { Link } from '@/i18n/navigation';

import { setEmployeeSkills, setNoSkillPolicy } from './skill-actions';
import styles from './EmployeeSkills.module.css';

type Row = Assigned['skills'][number] & { readonly situation: string | null };

/**
 * 07g - an employee's Skills tab (design 6).
 *
 *   left    the skills they carry, in the order they prefer them when two
 *           could apply (drag, or ↑↓); On / Watch / Off for this employee
 *           alone; then "When no skill fits", set once
 *   right   Add a skill: search, each candidate with who else uses it and -
 *           checked against this employee before anyone presses Add - where
 *           they would have to hand over
 *
 * ★ ONE SAVE, AS 07g's: the whole ordered list (Backend's PUT replaces it - a
 *   skill left out is removed) and the fallback (a PATCH, sent only when it
 *   changed). A skill added here starts in Watch.
 */
export function EmployeeSkills({
  employee,
  assigned,
  candidates,
  situations,
  head,
  tabs,
}: {
  /** 07g's header (avatar, name, standing, line) - Save sits beside it. */
  readonly head: ReactNode;
  readonly tabs: ReactNode;
  readonly employee: { readonly id: string; readonly name: string };
  readonly assigned: Assigned;
  readonly candidates: readonly { readonly skill: Skill; readonly fit: SkillFit | null }[] | null;
  /** Each skill's "in the customer's words", from the library. */
  readonly situations: ReadonlyMap<string, string | null>;
}) {
  const t = useTranslations('skills.employee');
  const [rows, setRows] = useState<readonly Row[]>(() =>
    [...assigned.skills]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ ...s, situation: situations.get(s.skillId) ?? null })),
  );
  const [policy, setPolicy] = useState<NoSkillPolicy>(assigned.noSkillPolicy);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [said, setSaid] = useState<'saved' | 'failed' | 'policyFailed' | null>(null);
  const [baseline, setBaseline] = useState(() => ({ rows, policy }));
  const [isPending, startTransition] = useTransition();

  const listOf = (list: readonly Row[]) => list.map((r) => `${r.skillId}:${r.mode}`).join(',');
  const listChanged = listOf(rows) !== listOf(baseline.rows);
  const policyChanged = policy !== baseline.policy;

  const carried = new Set(rows.map((r) => r.skillId));
  const open = (candidates ?? [])
    .filter(({ skill }) => !carried.has(skill.id))
    .filter(({ skill }) =>
      `${skill.name} ${skill.situation ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
    );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    setRows(next);
  };

  const add = (skill: Skill) =>
    setRows([
      ...rows,
      {
        skillId: skill.id,
        mode: 'watch',
        order: rows.length,
        name: skill.name,
        status: skill.status,
        category: skill.category,
        version: skill.version,
        runs: 0,
        situation: skill.situation,
      },
    ]);

  const save = () => {
    setSaid(null);
    startTransition(async () => {
      let next = baseline;
      if (listChanged) {
        const written = await setEmployeeSkills(
          employee.id,
          rows.map((r) => ({ skillId: r.skillId, mode: r.mode })),
        );
        if (written === null) {
          setSaid('failed');
          return;
        }
        next = { ...next, rows };
      }
      if (policyChanged) {
        if (!(await setNoSkillPolicy(employee.id, policy))) {
          setBaseline(next);
          setSaid('policyFailed');
          return;
        }
        next = { ...next, policy };
      }
      setBaseline(next);
      setSaid('saved');
    });
  };

  const fitLine = (fit: SkillFit | null) => {
    if (!fit || fit.fits || fit.handsOverAtStep === null) return null;
    const blocked = fit.steps.flatMap((s) => s.tools).find((tool) => tool.reason);
    return t('fit.handsOver', {
      name: employee.name,
      step: fit.handsOverAtStep,
      why: blocked?.reason
        ? t(`fit.reasons.${blocked.reason}`, {
            tool: blocked.actionLabel ?? humanizeTag(blocked.name.split('.').pop() ?? blocked.name),
          })
        : (fit.reason ?? ''),
    });
  };

  return (
    <div className={styles.tab}>
      <header className={styles.head}>
        {head}
        {said ? (
          <p
            className={styles.said}
            role="status"
            data-said={said}
            data-testid="employee-skills-said"
          >
            {t(`said.${said}`)}
          </p>
        ) : null}
        <button
          type="button"
          className={styles.save}
          disabled={isPending || (!listChanged && !policyChanged)}
          onClick={save}
          data-testid="employee-skills-save"
        >
          {isPending ? t('saving') : t('save')}
        </button>
      </header>
      {tabs}

      <div className={styles.columns}>
        <div className={styles.main}>
          {rows.length === 0 ? (
            <p className={styles.quiet} data-testid="employee-skills-none">
              {t('none', { name: employee.name })}
            </p>
          ) : (
            <ol className={styles.list} data-testid="employee-skills">
              {rows.map((row, i) => (
                <li
                  key={row.skillId}
                  className={styles.row}
                  data-testid={`employee-skill-${row.skillId}`}
                  onDragOver={(e: DragEvent) => e.preventDefault()}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault();
                    if (dragging !== null) move(dragging, i);
                    setDragging(null);
                  }}
                >
                  <span
                    className={styles.grip}
                    draggable
                    onDragStart={() => setDragging(i)}
                    onDragEnd={() => setDragging(null)}
                    aria-hidden="true"
                  >
                    <GripVertical size={14} />
                  </span>
                  <span className={styles.index}>{i + 1}</span>
                  <span className={styles.who}>
                    <Link href={`/studio/skills/${row.skillId}`} className={styles.name}>
                      <bdi dir="auto">{row.name}</bdi>
                    </Link>
                    {row.situation ? (
                      <span className={styles.quiet}>
                        <bdi dir="auto">{row.situation}</bdi>
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.runs}>
                    {row.mode === 'watch' ? t('watching') : t('runs', { count: row.runs })}
                  </span>
                  <span className={styles.order}>
                    <button
                      type="button"
                      className={styles.move}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                      aria-label={t('moveUp', { name: row.name })}
                      data-testid={`employee-skill-up-${row.skillId}`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.move}
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, i + 1)}
                      aria-label={t('moveDown', { name: row.name })}
                    >
                      ↓
                    </button>
                  </span>
                  <span
                    className={styles.modes}
                    role="radiogroup"
                    aria-label={t('modeFor', { name: row.name })}
                  >
                    {(['on', 'watch', 'off'] as const satisfies readonly SkillMode[]).map(
                      (mode) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={row.mode === mode}
                          className={styles.mode}
                          onClick={() =>
                            setRows(
                              rows.map((r) => (r.skillId === row.skillId ? { ...r, mode } : r)),
                            )
                          }
                          data-testid={`employee-skill-${row.skillId}-${mode}`}
                        >
                          {t(`modes.${mode}`)}
                        </button>
                      ),
                    )}
                  </span>
                  {row.status === 'draft' ? (
                    <span className={styles.draftNote} title={t('draftWhy')}>
                      {t('draft')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          <fieldset className={styles.fallback} data-testid="employee-no-skill">
            <legend className={styles.fallbackTitle}>{t('fallback.title')}</legend>
            {NO_SKILL_POLICIES.map((p) => (
              <label key={p} className={styles.radio}>
                <input
                  type="radio"
                  name="no-skill"
                  value={p}
                  checked={policy === p}
                  onChange={() => setPolicy(p)}
                  data-testid={`employee-no-skill-${p}`}
                />
                {t(`fallback.${p}`)}
              </label>
            ))}
          </fieldset>
        </div>

        <aside className={styles.add} data-testid="employee-add-skill">
          <h2 className={styles.addTitle}>{t('add.title')}</h2>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('add.search')}
              aria-label={t('add.search')}
              data-testid="employee-add-search"
            />
          </label>
          {candidates === null ? (
            <p className={styles.quiet}>{t('add.unread')}</p>
          ) : open.length === 0 ? (
            <p className={styles.quiet}>{query ? t('add.noMatch') : t('add.none')}</p>
          ) : (
            <ul className={styles.candidates}>
              {open.map(({ skill, fit }) => {
                const others = (skill.stats?.usedBy ?? []).filter(
                  (u) => u.aiAgentId !== employee.id && u.mode !== 'off',
                );
                const warning = fitLine(fit);
                return (
                  <li
                    key={skill.id}
                    className={styles.candidate}
                    data-testid={`employee-candidate-${skill.id}`}
                  >
                    <span className={styles.candidateTop}>
                      <span className={styles.who}>
                        <span className={styles.candidateName}>
                          <bdi dir="auto">{skill.name}</bdi>
                        </span>
                        <span className={styles.quiet}>
                          {others.length > 0
                            ? t('add.usedBy', { names: others.map((u) => u.name).join(', ') })
                            : t('add.usedByNobody')}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={styles.addButton}
                        onClick={() => add(skill)}
                        data-testid={`employee-add-${skill.id}`}
                      >
                        {t('add.add')}
                      </button>
                    </span>
                    {warning ? (
                      <p className={styles.warning} data-testid={`employee-fit-${skill.id}`}>
                        <Info size={13} aria-hidden="true" />
                        {warning}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href={{ pathname: '/studio/skills', query: { new: '1' } }}
            className={styles.write}
            data-testid="employee-write-skill"
          >
            {t('add.write')}
          </Link>
        </aside>
      </div>
    </div>
  );
}
