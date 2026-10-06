import { getFormatter, getTranslations } from 'next-intl/server';

import {
  SKILL_CATEGORIES,
  skillStanding,
  type Skill,
  type SkillCategory,
  type ToolChoice,
} from '@/api/contracts/skills';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { avatarTone, employeeInitials, skillSystems } from './skill-words';
import { ToolMark } from './ToolChip';
import styles from './Skills.module.css';

/**
 * 09 - Studio · Skills (design 6): every skill as the situation in the
 * customer's words, its steps and the systems they use, who carries it, and
 * how it did this week.
 *
 * ★ "Missing skills" and "From a template" are drawn and say why they are
 *   empty: suggestions from unhandled conversations and templates are the
 *   next phase of skills (plan §4). Nothing here is filled in by us.
 */
export async function SkillsLibrary({
  skills,
  tools,
  category,
}: {
  readonly skills: readonly Skill[] | null;
  readonly tools: ReadonlyMap<string, ToolChoice> | null;
  readonly category: SkillCategory | null;
}) {
  const t = await getTranslations('skills');
  const format = await getFormatter();
  const listed = (skills ?? []).filter((s) => s.status !== 'archived');
  const shown = category ? listed.filter((s) => s.category === category) : listed;
  const counts = new Map(
    SKILL_CATEGORIES.map((c) => [c, listed.filter((s) => s.category === c).length]),
  );

  return (
    <div className={styles.library}>
      <div className={styles.main}>
        {skills === null ? null : (
          <nav className={styles.filters} aria-label={t('columns.skill')}>
            <FilterLink
              active={category === null}
              href={{ pathname: '/studio/skills' }}
              testid="all"
            >
              {t('filter.all', { count: listed.length })}
            </FilterLink>
            {SKILL_CATEGORIES.filter((c) => c !== 'other' || (counts.get(c) ?? 0) > 0).map((c) => (
              <FilterLink
                key={c}
                active={category === c}
                href={{ pathname: '/studio/skills', query: { category: c } }}
                testid={c}
              >
                {t(`filter.${c}`, { count: counts.get(c) ?? 0 })}
              </FilterLink>
            ))}
          </nav>
        )}

        {skills === null ? (
          <p className={styles.note} role="status" data-testid="skills-unread">
            {t('unread')}
          </p>
        ) : shown.length === 0 ? (
          <p className={styles.note} data-testid="skills-empty">
            {category ? t('emptyFilter') : t('empty')}
          </p>
        ) : (
          <div className={styles.table} role="table" data-testid="skills-table">
            <div className={styles.head} role="row">
              <span role="columnheader">{t('columns.skill')}</span>
              <span role="columnheader">{t('columns.steps')}</span>
              <span role="columnheader">{t('columns.usedBy')}</span>
              <span role="columnheader">{t('columns.week')}</span>
              <span role="columnheader" />
            </div>
            {shown.map((skill) => {
              const standing = skillStanding(skill);
              const stats = skill.stats;
              const usedBy = (stats?.usedBy ?? []).filter((u) => u.mode !== 'off');
              const watchingOnly = usedBy.length > 0 && usedBy.every((u) => u.mode === 'watch');
              return (
                <Link
                  key={skill.id}
                  href={`/studio/skills/${skill.id}`}
                  className={styles.row}
                  role="row"
                  data-testid={`skill-${skill.id}`}
                >
                  <span className={styles.who}>
                    <span className={styles.name}>
                      <UserText>{skill.name}</UserText>
                    </span>
                    {skill.situation ? (
                      <span className={styles.situation}>
                        <UserText>{skill.situation}</UserText>
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.tools}>
                    <span className={styles.stepCount}>
                      {t('steps', { count: skill.steps.length })}
                    </span>
                    {skillSystems(skill, tools).map((system) => (
                      <span key={system.label} className={styles.toolChip}>
                        <ToolMark name={system.tool} slug={system.slug} />
                        {system.label}
                      </span>
                    ))}
                  </span>
                  <span className={styles.avatars} data-testid={`skill-used-by-${skill.id}`}>
                    {usedBy.length === 0 ? (
                      <span className={styles.muted}>{t('noOne')}</span>
                    ) : (
                      usedBy.map((u) => (
                        <span
                          key={u.aiAgentId}
                          className={styles.avatar}
                          data-tone={avatarTone(u.aiAgentId)}
                          title={u.name}
                        >
                          {employeeInitials(u.name)}
                        </span>
                      ))
                    )}
                  </span>
                  <span className={styles.week} data-testid={`skill-week-${skill.id}`}>
                    {stats === null ? (
                      <span className={styles.muted} title={t('statsUnread')}>
                        -
                      </span>
                    ) : (
                      <>
                        <span>
                          {t('runs', { count: watchingOnly ? stats.watchRuns : stats.runs })}
                        </span>
                        <span className={styles.muted}>
                          {watchingOnly
                            ? t('watching')
                            : stats.runs === 0
                              ? t('notRunYet')
                              : stats.aloneShare === null
                                ? '-'
                                : t('alone', {
                                    share: format.number(stats.aloneShare, { style: 'percent' }),
                                  })}
                        </span>
                      </>
                    )}
                  </span>
                  <span className={styles.standing}>
                    <span
                      className={styles.chip}
                      data-standing={standing.kind}
                      data-testid={`skill-standing-${skill.id}`}
                    >
                      {standing.kind === 'live' ? (
                        <span className={styles.dot} aria-hidden="true" />
                      ) : null}
                      {standing.kind === 'approval'
                        ? t('standing.approval', { amount: format.number(standing.amount) })
                        : t(`standing.${standing.kind}`)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <aside className={styles.side}>
        <section className={styles.missing} data-testid="skills-missing">
          <h2 className={styles.missingTitle}>
            <span className={styles.missingDot} aria-hidden="true" />
            {t('missing.title')}
          </h2>
          <p className={styles.missingWhy}>{t('missing.why')}</p>
        </section>
        <section className={styles.explainer}>
          <h2 className={styles.explainerTitle}>{t('explainer.title')}</h2>
          <p className={styles.explainerBody}>{t('explainer.body')}</p>
          <Link href="/studio/automations" className={styles.explainerLink}>
            {t('explainer.link')}
          </Link>
        </section>
      </aside>
    </div>
  );
}

function FilterLink({
  active,
  href,
  testid,
  children,
}: {
  readonly active: boolean;
  readonly href: { pathname: '/studio/skills'; query?: Record<string, string> };
  readonly testid: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={styles.filter}
      aria-current={active ? 'page' : undefined}
      data-testid={`skills-filter-${testid}`}
      scroll={false}
    >
      {children}
    </Link>
  );
}
