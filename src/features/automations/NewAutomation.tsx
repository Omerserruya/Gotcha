'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { TRIGGER_TYPES, type Catalog, type TriggerType } from '@/api/contracts/automations';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { useRouter } from '@/i18n/navigation';

import { createAutomation, type CreateResult } from './automation-actions';
import { templateOf, type TemplateKey } from './templates';
import { StepSheet } from './StepSheet';
import styles from './StepSheet.module.css';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * New automation (09c → 09e → 09d). The sheet opens on the first step, so
 * only triggers can be chosen; a trigger chosen asks only what it cannot go
 * without - a name, the tags for "Tag added", the time for "On a schedule" -
 * then creates the draft and opens it in the builder. A draft runs nowhere.
 */
export function NewAutomation({
  catalog,
  templateKey = null,
}: {
  readonly catalog: Catalog | null;
  /**
   * 09c's template chosen: its trigger and graph, prefilled. ★ The KEY, never
   * the template: a server component hands this over, and a template carries
   * its `build` function - which React cannot send to the client (dev,
   * 8df59dd: every `?template=` crashed to the error page).
   */
  readonly templateKey?: TemplateKey | null;
}) {
  const t = useTranslations('automations');
  const template = templateOf(templateKey ?? undefined);
  const router = useRouter();
  const [trigger, setTrigger] = useState<TriggerType | null>(template?.trigger ?? null);
  const [name, setName] = useState(template ? t(`template.${template.key}.name`) : '');
  const [tags, setTags] = useState('');
  const [at, setAt] = useState('09:00');
  const [days, setDays] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<Exclude<CreateResult, { ok: true }> | null>(null);
  const [isCreating, start] = useTransition();
  const close = () => router.replace('/studio/automations', { scroll: false });

  if (trigger === null) {
    return (
      <StepSheet
        catalog={catalog}
        context={t('sheet.firstStep')}
        onClose={close}
        onPick={(item) => {
          const type = item.type.replace(/^trigger:/, '');
          if (!(TRIGGER_TYPES as readonly string[]).includes(type)) return;
          setTrigger(type as TriggerType);
          setName(t(`nodes.trigger.${type}` as 'nodes.trigger.webhook'));
        }}
      />
    );
  }

  const tagList = tags
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const ready =
    name.trim() !== '' &&
    (trigger !== 'tag_added' || tagList.length > 0) &&
    (trigger !== 'schedule' || TIME.test(at));

  const create = () =>
    start(async () => {
      setFailed(null);
      const asked: Record<string, unknown> =
        trigger === 'tag_added'
          ? { tags: tagList }
          : trigger === 'schedule'
            ? { at, ...(days.size > 0 ? { days: DAYS.filter((d) => days.has(d)) } : {}) }
            : {};
      const graph = template?.build?.(
        {
          keyword: t('templateWords.keyword'),
          // The variable goes in as itself; the words around it are the author's language.
          welcome: t('templateWords.welcome', { name: '{{first_name}}' }),
          adText: t('templateWords.adText', { name: '{{first_name}}' }),
          prices: t('templateWords.prices'),
          talk: t('templateWords.talk'),
        },
        () => crypto.randomUUID(),
      );
      const result = await createAutomation({
        name: name.trim(),
        trigger: { type: trigger, config: { ...(graph?.config ?? {}), ...asked } },
        ...(graph ? { nodes: graph.nodes, edges: graph.edges } : {}),
      });
      if (result.ok) router.push(`/studio/automations/${result.automation.id}`);
      else setFailed(result);
    });

  return (
    <Dialog open onOpenChange={(open) => (open ? null : close())}>
      <DialogContent
        title={t('new.title')}
        description={t('new.lead')}
        data-testid="new-automation"
      >
        <div className={styles.setup}>
          <p className={styles.chosen}>
            {t('new.when', { trigger: t(`nodes.trigger.${trigger}` as 'nodes.trigger.webhook') })}
          </p>
          {template ? <p className={styles.itemLine}>{t('new.fromTemplate')}</p> : null}
          <label className={styles.field}>
            <span>{t('new.name')}</span>
            <input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              dir="auto"
              data-testid="new-automation-name"
            />
          </label>
          {trigger === 'tag_added' ? (
            <label className={styles.field}>
              <span>{t('new.tags')}</span>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder={t('new.tagsHint')}
                dir="auto"
                data-testid="new-automation-tags"
              />
            </label>
          ) : null}
          {trigger === 'schedule' ? (
            <>
              <label className={styles.field}>
                <span>{t('new.at')}</span>
                <input
                  type="time"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  data-testid="new-automation-at"
                />
              </label>
              <div className={styles.days} role="group" aria-labelledby="new-automation-days">
                <span className={styles.daysTitle} id="new-automation-days">
                  {t('new.days')}
                </span>
                {DAYS.map((day) => (
                  <label key={day} className={styles.day}>
                    <input
                      type="checkbox"
                      checked={days.has(day)}
                      onChange={(e) => {
                        const next = new Set(days);
                        if (e.target.checked) next.add(day);
                        else next.delete(day);
                        setDays(next);
                      }}
                    />
                    {t(`days.${day}`)}
                  </label>
                ))}
                <span className={styles.itemLine}>{t('new.everyDay')}</span>
              </div>
            </>
          ) : null}
          {failed ? (
            <p className={styles.problem} role="alert" data-testid="new-automation-failed">
              {t(`new.failed.${failed.reason}`)}
            </p>
          ) : null}
          <span className={styles.setupActions}>
            {template ? null : (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setTrigger(null)}
              >
                {t('new.back')}
              </button>
            )}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={create}
              disabled={!ready || isCreating}
              data-testid="new-automation-create"
            >
              {isCreating ? t('new.creating') : t('new.create')}
            </button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
