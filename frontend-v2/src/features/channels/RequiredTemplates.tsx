'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  BODY_MAX,
  isEditable,
  roleOfItem,
  stateOfItem,
  type RequiredItem,
  type RequiredTemplates as Required,
} from '@/api/contracts/required-templates';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import {
  loadRequiredTemplates,
  saveRequiredTemplate,
  type RequiredSaveResult,
} from './required-templates-actions';
import styles from './Channels.module.css';

type Outcome =
  | { readonly kind: 'saved' | 'submitted' }
  | {
      readonly kind: Exclude<Extract<RequiredSaveResult, { ok: false }>['reason'], 'forbidden'>;
      readonly templateId: string | null;
    };

const keyOf = (item: RequiredItem) => `${item.role}:${item.language}`;
const VARIABLE = /\{\{\s*1\s*\}\}/;

/** Outreach · Templates, on this template when its id is known. */
function outreachHref(templateId: string | null) {
  return templateId
    ? { pathname: '/outreach/templates' as const, query: { template: templateId } }
    : '/outreach/templates';
}

/**
 * The WhatsApp templates every number needs (Backend 7e91418b): each role with
 * its purpose, its text (editable while it is ours to change), its state, and
 * Meta's reason when it was rejected. Used by the connect flow's step and by
 * the number's Templates tab, the same list in both.
 *
 * ★ Two writes, never one: "Save as draft" is `submit: false`. Sending to Meta
 *   is its own button and asks first, because a submit is real, outward and
 *   cannot be taken back.
 */
export function RequiredTemplates({ initial }: { readonly initial: Required }) {
  const t = useTranslations('channels.whatsapp.required');
  const [data, setData] = useState(initial);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});
  const [forbidden, setForbidden] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState<'save' | 'submit' | null>(null);
  const [isPending, startTransition] = useTransition();

  const editable = data.items.filter(isEditable);
  const textOf = (item: RequiredItem) => drafts[keyOf(item)] ?? item.body;
  const invalid = editable.some((i) => !textOf(i).trim() || textOf(i).length > BODY_MAX);
  const busy = isPending || running !== null;

  function run(submit: boolean) {
    setConfirming(false);
    setForbidden(false);
    setRunning(submit ? 'submit' : 'save');
    startTransition(async () => {
      const next: Record<string, Outcome> = {};
      for (const item of editable) {
        const role = roleOfItem(item);
        if (!role) continue;
        const result = await saveRequiredTemplate({
          channelAccountId: data.channelAccountId,
          role,
          language: item.language,
          body: textOf(item),
          button: item.buttons[0] ?? null,
          submit,
        });
        if (result.ok) {
          next[keyOf(item)] = { kind: result.submitted ? 'submitted' : 'saved' };
          continue;
        }
        if (result.reason === 'forbidden') {
          // Every other one would answer the same: stop, and say who can.
          setForbidden(true);
          break;
        }
        next[keyOf(item)] = { kind: result.reason, templateId: result.templateId ?? null };
      }
      setOutcomes(next);
      // States move on a save or a submit: read them again.
      const fresh = await loadRequiredTemplates(data.channelAccountId);
      if (fresh.ok) setData(fresh.data);
      setRunning(null);
    });
  }

  return (
    <div className={styles.reqBlock} data-testid="required-templates">
      {!data.canSubmit ? (
        <p className={styles.tabNote} data-testid="required-not-connected">
          {t('notConnected')}
        </p>
      ) : null}
      {data.items.length === 0 ? (
        <p className={styles.tabNote} data-testid="required-none">
          {t('none')}
        </p>
      ) : (
        <ul className={styles.tabList}>
          {data.items.map((item) => {
            const key = keyOf(item);
            const role = roleOfItem(item);
            const state = stateOfItem(item);
            const outcome = outcomes[key];
            const text = textOf(item);
            const inOutreach =
              state === 'approved' || state === 'pending' || outcome?.kind === 'already_submitted';
            return (
              <li
                key={key}
                className={styles.reqItem}
                data-testid={`required-${item.role}-${item.language}`}
              >
                <div className={styles.reqHead}>
                  <span className={styles.tabRowName}>
                    {role ? t(`role.${role}.title`) : <UserText>{item.name}</UserText>}
                    {data.languages.length > 1 ? (
                      <span className={styles.tabRowMeta}> · {item.language.toUpperCase()}</span>
                    ) : null}
                  </span>
                  <span
                    className={styles.reqChip}
                    data-state={state}
                    data-testid={`required-state-${item.role}-${item.language}`}
                  >
                    {t(`state.${state}`)}
                  </span>
                </div>
                {role ? (
                  <span className={styles.tabRowMeta}>{t(`role.${role}.purpose`)}</span>
                ) : null}
                {isEditable(item) ? (
                  <label className={styles.reqField}>
                    <span>{t('bodyLabel')}</span>
                    <textarea
                      dir="auto"
                      rows={3}
                      value={text}
                      maxLength={BODY_MAX}
                      disabled={busy}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      data-testid={`required-body-${item.role}-${item.language}`}
                    />
                  </label>
                ) : (
                  <UserText className={styles.reqBody}>{item.body}</UserText>
                )}
                {VARIABLE.test(text) ? (
                  <span className={styles.tabRowMeta}>{t('variable', { token: '{{1}}' })}</span>
                ) : null}
                {item.buttons[0] ? (
                  <span className={styles.tabRowMeta}>
                    {t('button')} <UserText>{item.buttons[0]}</UserText>
                  </span>
                ) : null}
                {item.reason ? (
                  <span
                    className={styles.reqReason}
                    data-testid={`required-reason-${item.role}-${item.language}`}
                  >
                    {t('reason')} <UserText>{item.reason}</UserText>
                  </span>
                ) : null}
                {outcome ? (
                  <span
                    className={
                      outcome.kind === 'saved' || outcome.kind === 'submitted'
                        ? styles.tabRowMeta
                        : styles.footProblem
                    }
                    role={
                      outcome.kind === 'saved' || outcome.kind === 'submitted' ? 'status' : 'alert'
                    }
                    data-testid={`required-outcome-${item.role}-${item.language}`}
                  >
                    {t(`outcome.${outcome.kind}`, { max: BODY_MAX })}
                  </span>
                ) : null}
                {inOutreach ? (
                  <Link
                    href={outreachHref(
                      (outcome && 'templateId' in outcome ? outcome.templateId : null) ??
                        item.templateId,
                    )}
                    className={styles.numberLink}
                    data-testid={`required-outreach-${item.role}-${item.language}`}
                  >
                    {t('editInOutreach')}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {forbidden ? (
        <p className={styles.footProblem} role="alert" data-testid="required-forbidden">
          {t('forbidden')}
        </p>
      ) : null}

      {editable.length > 0 ? (
        confirming ? (
          <div className={styles.rowConfirm} role="alertdialog" data-testid="required-confirm">
            <span>{t('confirm')}</span>
            <button
              type="button"
              className={styles.confirmKeep}
              onClick={() => setConfirming(false)}
              data-testid="required-confirm-no"
            >
              {t('confirmNo')}
            </button>
            <button
              type="button"
              className={styles.contactAdd}
              disabled={busy || !data.canSubmit || invalid}
              onClick={() => run(true)}
              data-testid="required-confirm-yes"
            >
              {t('confirmYes')}
            </button>
          </div>
        ) : (
          <div className={styles.reqActions}>
            <button
              type="button"
              className={styles.confirmKeep}
              disabled={busy || invalid}
              onClick={() => run(false)}
              data-testid="required-save"
            >
              {running === 'save' ? t('saving') : t('save')}
            </button>
            <button
              type="button"
              className={styles.contactAdd}
              disabled={busy || invalid || !data.canSubmit}
              onClick={() => setConfirming(true)}
              data-testid="required-submit"
            >
              {running === 'submit' ? t('sending') : t('submit')}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
