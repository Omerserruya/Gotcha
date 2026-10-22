'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { fillTemplate, type ReplyTemplate } from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { prefillValue } from './reply-window';
import {
  loadReplyTemplates,
  sendTemplate,
  type TemplateListResult,
  type TemplateSendResult,
} from './template-actions';

import styles from './Inbox.module.css';

/**
 * Past WhatsApp's 24 hours: the approved templates of this number, each
 * previewed as the customer will read it, its variables to fill, and Send.
 *
 * ⚠⚠ SEND HERE IS A REAL WHATSAPP MESSAGE. It is pressed only by a person;
 *    the tests mock `template-actions` and nothing here runs on its own.
 */
export function TemplatePicker({
  conversationId,
  customerName,
  onQueued,
  onClose,
}: {
  readonly conversationId: string;
  readonly customerName: string | null;
  readonly onQueued: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations('inbox.composer');
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<TemplateListResult | null>(null);
  const [chosen, setChosen] = useState<ReplyTemplate | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TemplateSendResult | null>(null);

  useEffect(() => {
    let live = true;
    void loadReplyTemplates(conversationId)
      .catch((): TemplateListResult => ({ ok: false }))
      .then((outcome) => {
        if (live) setList(outcome);
      });
    return () => {
      live = false;
    };
  }, [conversationId, attempt]);

  const choose = (template: ReplyTemplate) => {
    setChosen(template);
    setResult(null);
    setValues(
      Object.fromEntries(
        template.placeholders.map((p) => [p.key, prefillValue(p, customerName)] as const),
      ),
    );
  };

  const blank = chosen !== null && chosen.placeholders.some((p) => !values[p.key]?.trim());

  const send = () => {
    if (chosen === null || blank || sending) return;
    setSending(true);
    setResult(null);
    void sendTemplate(conversationId, chosen.id, values)
      .catch((): TemplateSendResult => ({ ok: false, reason: 'failed' }))
      .then((outcome) => {
        setResult(outcome);
        if (outcome.ok) onQueued();
      })
      .finally(() => setSending(false));
  };

  return (
    <section
      className={styles.templatePicker}
      aria-label={t('template.title')}
      data-testid="template-picker"
    >
      <p className={styles.templatePickerHead}>
        <span>{t('template.title')}</span>
        <button
          type="button"
          className={styles.composerChip}
          data-testid="template-close"
          onClick={onClose}
        >
          {t('template.cancel')}
        </button>
      </p>

      {list === null ? (
        <p className={styles.composerNote} data-testid="template-loading">
          {t('template.loading')}
        </p>
      ) : !list.ok ? (
        <p className={styles.composerProblem} data-testid="template-load-failed">
          {t('template.loadFailed')}{' '}
          <button
            type="button"
            className={styles.composerChip}
            data-testid="template-retry"
            onClick={() => {
              setList(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t('template.retry')}
          </button>
        </p>
      ) : list.templates.length === 0 ? (
        <p className={styles.composerNote} data-testid="template-none">
          {t('template.none')}{' '}
          <Link href="/outreach/templates" data-testid="template-none-link">
            {t('template.noneLink')}
          </Link>
        </p>
      ) : (
        <>
          <ul className={styles.templateList} data-testid="template-list">
            {list.templates.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  className={styles.composerChip}
                  data-testid={`template-option-${template.id}`}
                  aria-pressed={chosen?.id === template.id}
                  disabled={sending}
                  onClick={() => choose(template)}
                >
                  <UserText>{template.name}</UserText>
                  {template.language ? ` · ${template.language}` : null}
                </button>
              </li>
            ))}
          </ul>

          {chosen === null ? null : (
            <>
              <p className={styles.templatePreviewLabel}>{t('template.preview')}</p>
              <p className={styles.templatePreview} data-testid="template-preview">
                {chosen.headerType === 'TEXT' && chosen.headerContent ? (
                  <>
                    <strong>
                      <UserText>{fillTemplate(chosen.headerContent, values)}</UserText>
                    </strong>
                    {'\n'}
                  </>
                ) : null}
                <UserText>{fillTemplate(chosen.body, values)}</UserText>
                {chosen.footer ? (
                  <span className={styles.templateFooter}>
                    <UserText>{chosen.footer}</UserText>
                  </span>
                ) : null}
                {chosen.buttons
                  .filter((b) => b.text)
                  .map((b, i) => (
                    <span key={i} className={styles.templateFooter}>
                      <UserText>{b.text}</UserText>
                    </span>
                  ))}
              </p>

              {chosen.placeholders.map((p) => (
                <label key={p.key} className={styles.templateField}>
                  <span>{t('template.field', { key: p.key })}</span>
                  <input
                    type="text"
                    dir="auto"
                    data-testid={`template-var-${p.key}`}
                    value={values[p.key] ?? ''}
                    disabled={sending}
                    // Enter here would submit the composer's form. It sends nothing.
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                    onChange={(event) => {
                      const value = event.target.value;
                      setResult(null);
                      setValues((now) => ({ ...now, [p.key]: value }));
                    }}
                  />
                </label>
              ))}

              <div className={styles.templateActions}>
                <button
                  type="button"
                  className={styles.composerChip}
                  data-testid="template-send"
                  disabled={blank || sending}
                  onClick={send}
                >
                  {sending ? t('template.sending') : t('template.send')}
                </button>
                {blank ? (
                  <span className={styles.composerNote} data-testid="template-blank">
                    {t('template.blank')}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </>
      )}

      {result && !result.ok ? (
        <p className={styles.composerProblem} data-testid="template-problem" aria-live="polite">
          {result.reason === 'not_usable'
            ? t('template.error.notUsable')
            : result.reason === 'whatsapp_only'
              ? t('template.error.whatsappOnly')
              : result.reason === 'channel_not_configured'
                ? t('error.channelGone')
                : result.reason === 'not_found'
                  ? t('error.gone')
                  : result.reason === 'blank'
                    ? t('template.blank')
                    : t('template.error.failed')}
        </p>
      ) : null}
    </section>
  );
}
