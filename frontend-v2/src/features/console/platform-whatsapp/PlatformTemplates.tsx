'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  TEMPLATE_LANGUAGES,
  isEditable,
  isSubmittable,
  type PlatformTemplate,
  type TemplateLanguage,
  type TemplateLanguageRow,
  type TemplateStatus,
} from '@/api/contracts/platform-whatsapp';
import { Button } from '@/design-system/primitives/button/Button';
import {
  StatusIndicator,
  type StatusTone,
} from '@/design-system/primitives/status/StatusIndicator';
import { useRouter } from '@/i18n/navigation';

import { ConfirmedAction } from '../ConfirmedAction';
import consoleStyles from '../Console.module.css';
import { alertLabel } from './alert-label';
import {
  savePlatformTemplate,
  submitPlatformTemplate,
  syncPlatformTemplates,
  type PlatformWrite,
} from './platform-whatsapp-actions';
import styles from './PlatformWhatsApp.module.css';

const TONE: Record<TemplateStatus, StatusTone> = {
  NOT_SUBMITTED: 'neutral',
  PENDING: 'waiting',
  APPROVED: 'done',
  REJECTED: 'waiting',
  PAUSED: 'waiting',
  DISABLED: 'waiting',
  IN_APPEAL: 'waiting',
  PENDING_DELETION: 'neutral',
  UNKNOWN: 'neutral',
};

/** `{{1}} {{2}}` for a template with two: what an edit must keep. */
const placeholders = (count: number) =>
  Array.from({ length: count }, (_, i) => `{{${i + 1}}}`).join(' ');

/**
 * Every platform alert's template, in Hebrew and English: its text, Meta's
 * state and reason, and the two writes. Saving is a draft and reaches no
 * one; sending to Meta is its own button and asks first (RequiredTemplates'
 * rule: a submit is outward and cannot be taken back).
 */
export function PlatformTemplates({
  templates,
  canSubmit,
}: {
  readonly templates: readonly PlatformTemplate[];
  /** A number is connected: Meta has a WABA to review them on. */
  readonly canSubmit: boolean;
}) {
  const t = useTranslations('console.platformWhatsApp');
  return (
    <section
      className={consoleStyles.card}
      aria-labelledby="platform-templates"
      data-testid="platform-templates"
    >
      <div className={styles.head}>
        <h2 id="platform-templates" className={consoleStyles.cardTitle}>
          {t('templates.title')}
        </h2>
        <Sync />
      </div>
      <p className={styles.quiet}>{t('templates.description')}</p>
      {canSubmit ? null : (
        <p className={styles.quiet} data-testid="platform-templates-no-number">
          {t('templates.noNumber')}
        </p>
      )}
      <ul className={styles.templates} role="list">
        {templates.map((template) => (
          <li
            key={template.eventType}
            className={styles.template}
            data-testid={`tpl-${template.name}`}
          >
            <div className={styles.templateHead}>
              <h3 className={styles.templateName}>{alertLabel(t, template.name)}</h3>
              <span className={styles.metaName} dir="ltr">
                {template.name}
              </span>
            </div>
            <div className={styles.languages}>
              {TEMPLATE_LANGUAGES.map((lang) => (
                <Language
                  key={lang}
                  template={template}
                  lang={lang}
                  row={template.languages[lang]}
                  canSubmit={canSubmit}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sync() {
  const t = useTranslations('console.platformWhatsApp');
  const router = useRouter();
  const [outcome, setOutcome] = useState<PlatformWrite | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <span className={consoleStyles.action}>
      <Button
        size="sm"
        disabled={isPending}
        data-testid="platform-templates-sync"
        onClick={() => {
          setOutcome(null);
          startTransition(async () => {
            const done = await syncPlatformTemplates();
            setOutcome(done);
            if (done.ok) router.refresh();
          });
        }}
      >
        {t('templates.sync')}
      </Button>
      {outcome ? (
        <span
          className={outcome.ok ? consoleStyles.done : consoleStyles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid="platform-templates-sync-outcome"
        >
          {outcome.ok ? t('templates.synced') : t(`refusal.${outcome.reason}`)}
        </span>
      ) : null}
    </span>
  );
}

function Language({
  template,
  lang,
  row,
  canSubmit,
}: {
  readonly template: PlatformTemplate;
  readonly lang: TemplateLanguage;
  readonly row: TemplateLanguageRow | null;
  readonly canSubmit: boolean;
}) {
  const t = useTranslations('console.platformWhatsApp');
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PlatformWrite | null>(null);
  const [isPending, startTransition] = useTransition();
  const id = `tpl-${template.name}-${lang}`;

  if (!row) {
    return (
      <div className={styles.language} data-testid={id}>
        <div className={styles.languageHead}>
          <span>{t(`templates.lang.${lang}`)}</span>
        </div>
        <p className={styles.quiet}>{t('templates.missing')}</p>
      </div>
    );
  }

  const text = row.draftBody ?? row.body;
  const editable = isEditable(template, row.status);

  return (
    <div className={styles.language} data-testid={id} data-status={row.status}>
      <div className={styles.languageHead}>
        <span>{t(`templates.lang.${lang}`)}</span>
        <span data-testid={`${id}-status`}>
          <StatusIndicator tone={TONE[row.status]}>
            {t(`templates.status.${row.status}`)}
          </StatusIndicator>
        </span>
      </div>

      {editing !== null ? (
        <>
          <textarea
            className={styles.editor}
            dir={lang === 'he' ? 'rtl' : 'ltr'}
            lang={lang}
            aria-label={t('templates.bodyLabel', {
              alert: alertLabel(t, template.name),
              lang: t(`templates.lang.${lang}`),
            })}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            data-testid={`${id}-editor`}
          />
          {template.parameterCount > 0 ? (
            <p className={styles.quiet}>
              {t('templates.placeholders')}:{' '}
              <span dir="ltr" className={consoleStyles.code}>
                {placeholders(template.parameterCount)}
              </span>
            </p>
          ) : null}
          {row.status === 'APPROVED' ? (
            <p className={styles.quiet} data-testid={`${id}-approved-edit`}>
              {t('templates.approvedEdit')}
            </p>
          ) : null}
          <span className={consoleStyles.confirmActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={isPending || editing.trim() === '' || editing === text}
              data-testid={`${id}-save`}
              onClick={() => {
                setOutcome(null);
                const body = editing;
                startTransition(async () => {
                  const done = await savePlatformTemplate(template.eventType, lang, body);
                  setOutcome(done);
                  if (done.ok) {
                    setEditing(null);
                    router.refresh();
                  }
                });
              }}
            >
              {t('templates.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isPending}
              data-testid={`${id}-cancel`}
              onClick={() => {
                setEditing(null);
                setOutcome(null);
              }}
            >
              {t('templates.cancel')}
            </Button>
          </span>
        </>
      ) : (
        <p
          className={styles.body}
          dir={lang === 'he' ? 'rtl' : 'ltr'}
          lang={lang}
          data-testid={`${id}-body`}
        >
          {text}
        </p>
      )}

      {row.draftBody !== null && editing === null ? (
        <p className={styles.quiet} data-testid={`${id}-draft`}>
          {t('templates.draft')}
        </p>
      ) : null}
      {!template.editable ? <p className={styles.quiet}>{t('templates.fixed')}</p> : null}
      {row.status === 'REJECTED' && row.rejectedReason ? (
        <p className={consoleStyles.refused} data-testid={`${id}-reason`}>
          {t('templates.rejectedBecause', { reason: row.rejectedReason })}
        </p>
      ) : null}

      {editing === null ? (
        <span className={consoleStyles.confirmActions}>
          {editable ? (
            <Button
              size="sm"
              data-testid={`${id}-edit`}
              onClick={() => {
                setOutcome(null);
                setEditing(text);
              }}
            >
              {t('templates.edit')}
            </Button>
          ) : null}
          {isSubmittable(row) ? (
            <ConfirmedAction<PlatformWrite>
              label={t('templates.submit.action')}
              sentences={[t('templates.submit.first'), t('templates.submit.second')]}
              yes={t('templates.submit.yes')}
              run={() => submitPlatformTemplate(template.eventType, lang)}
              done={() => t('templates.submit.done')}
              refused={(result) => t(`refusal.${result.reason}`)}
              disabled={!canSubmit}
              testid={`${id}-submit`}
            />
          ) : null}
        </span>
      ) : null}

      {outcome ? (
        <p
          className={outcome.ok ? consoleStyles.done : consoleStyles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid={`${id}-outcome`}
        >
          {outcome.ok ? t('templates.saved') : t(`refusal.${outcome.reason}`)}
        </p>
      ) : null}
    </div>
  );
}
