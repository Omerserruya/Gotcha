'use client';

import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './Studio.module.css';

/**
 * Studio's index - screen 12 of Wave 3's list, and until now an 18-line
 * placeholder that rendered a title and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IT BORROWS EVERY WORD. NOTHING HERE IS NEW COPY.
 * ════════════════════════════════════════════════════════════════════════════
 * Each card shows the destination screen's OWN title and description - "What
 * GOTCHA knows / Where it learned about your business, and the questions it
 * could not answer." A summary written here would be a second vocabulary for
 * the same four things, and a second vocabulary is a second thing to drift: the
 * day somebody rewrites the Knowledge screen's description, this index would
 * quietly keep describing the old one.
 *
 * It also means the index cannot describe an area wrongly, because it is not
 * describing anything.
 *
 * ── AND IT IS GIVEN THE NAVIGATION, NOT A LIST OF ITS OWN ──
 * The page passes `STUDIO_SECTIONS` - what the sidebar renders - so a fifth area
 * appears here without anybody remembering this file exists, which is the only
 * arrangement that survives somebody adding a fifth area.
 *
 * ★ PASSED IN RATHER THAN IMPORTED, AND THE REASON IS A BOUNDARY I BROKE FIRST.
 * `features` may not import `shell` and `shell` may not import `features`; both
 * may import `lib`, but `lib` may only import `lib`, so a shared list there could
 * not carry `PermissionString`. The page is in `app`, which may import both, and
 * a composition root is where a dependency like this belongs anyway. The prop
 * type is declared here structurally so this file names nothing from `shell`.
 *
 * ── PERMISSIONS ──
 * Filtered with the same `canSee` the sidebar uses, so the index and the
 * sidebar cannot disagree about what exists. `canSee` returns **true** when the
 * permission set could not be read: a product that appears to have vanished is
 * worse than a link that leads to a page explaining the refusal.
 */

/**
 * Which message namespace holds each area's own words.
 *
 * Written out rather than derived from the section id. They happen to match
 * today, and a mapping that works by coincidence breaks silently the first time
 * somebody names a section differently from its catalogue.
 */
const NAMESPACE: Record<
  string,
  'employees' | 'knowledge' | 'skills' | 'automations' | 'capabilities'
> = {
  employees: 'employees',
  knowledge: 'knowledge',
  skills: 'skills',
  automations: 'automations',
  capabilities: 'capabilities',
};

/**
 * One Studio area, as much of `NavigationChild` as this panel uses.
 *
 * Declared structurally rather than imported from `shell`, so the boundary holds
 * and the page is free to pass its own list in a test.
 */
export interface StudioArea {
  readonly id: string;
  readonly href?: string;
  readonly permission?: string;
}

export function StudioIndex({ areas }: { readonly areas: readonly StudioArea[] }) {
  const t = useTranslations('studio');
  const { canSee } = usePermissions();
  const employees = useTranslations('employees');
  const knowledge = useTranslations('knowledge');
  const skills = useTranslations('skills');
  const automations = useTranslations('automations');
  const capabilities = useTranslations('capabilities');
  const words = { employees, knowledge, skills, automations, capabilities };

  /*
   * `href` is optional on a navigation child, so a section without one is not a
   * destination and cannot be a card on an index of destinations. Filtered rather
   * than rendered as dead text: a card that does not go anywhere reads as a
   * broken link, which is a worse report than not being listed.
   */
  const visible = areas.filter(
    (section) => section.href !== undefined && canSee(section.permission),
  );

  /*
   * Every area is permission-gated, so a role with none of the four reaches a
   * real state here. It says so rather than rendering an empty page, which is
   * indistinguishable from something failing to load.
   */
  if (visible.length === 0) {
    return (
      <p className={styles.none} data-testid="studio-none">
        {t('index.noAccess')}
      </p>
    );
  }

  return (
    /*
      ★★ NO LEAD SENTENCE. It read "Where GOTCHA is taught what to know, what it
      may do, and who does it." directly under a page description reading "Where
      GOTCHA is taught." - **the second contained the first verbatim**, which is
      the one shape of duplication that is not a judgement call.

      The page description is now the informative one and this says nothing,
      because four cards naming four areas do not need an introduction. The
      alternative - two sentences doing one job - is how the Automations screen
      was misread as duplicated when it was not.
    */
    <div className={styles.index} data-testid="studio-index">
      <ul className={styles.areas}>
        {visible.map((section) => {
          const namespace = NAMESPACE[section.id];
          /*
           * A section with no namespace mapped is a section somebody added to the
           * navigation without copy. It still gets a card, with the sidebar's
           * label, rather than disappearing from an index whose whole job is to
           * list what exists.
           */
          const own = namespace ? words[namespace] : null;
          return (
            <li key={section.id} className={styles.area}>
              <Link
                href={section.href!}
                className={styles.areaLink}
                data-testid={`studio-area-${section.id}`}
              >
                <span className={styles.areaName}>
                  {own ? own('title') : t(`sections.${section.id}` as 'sections.employees')}
                </span>
                {own ? <span className={styles.areaWhat}>{own('description')}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
