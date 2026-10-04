'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import drawer from '@/design-system/styles/drawer.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import { createCampaignDraft } from './create-actions';
import styles from './Outreach.module.css';

export interface SendingAccount {
  readonly id: string;
  /** `WHATSAPP`, `EMAIL`, … */
  readonly channel: string;
  /** How 13 names it: "WhatsApp · +972 …". */
  readonly label: string;
}

export interface UsableTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  /** The account it belongs to; `null` when it is the tenant's. */
  readonly channelAccountId: string | null;
}

/**
 * 05's "Create outreach · Campaign" — a DRAFT (Omer, 2026-10-04).
 *
 * The campaign as 02 reads it: who it goes from, what they get, when. WhatsApp
 * sends only an approved template, so for a WhatsApp account the message is a
 * template choice; any other channel takes the words themselves. Saving
 * creates the draft and opens it; sending it is a separate write and stays
 * drawn until approved.
 */
export function CampaignForm({
  accounts,
  templates,
  initialTemplateId,
  initialChannel,
}: {
  readonly accounts: readonly SendingAccount[];
  /** APPROVED templates only — nothing else can be sent on WhatsApp. */
  readonly templates: readonly UsableTemplate[];
  readonly initialTemplateId?: string;
  readonly initialChannel?: string;
}) {
  const t = useTranslations('outreach.create');
  const router = useRouter();
  const first =
    accounts.find((a) =>
      initialChannel ? a.channel === initialChannel : a.channel === 'WHATSAPP',
    ) ?? accounts[0];
  const [accountId, setAccountId] = useState(first?.id ?? '');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const isWhatsApp = account?.channel === 'WHATSAPP';
  const forAccount = templates.filter(
    (tpl) => tpl.channelAccountId === null || tpl.channelAccountId === accountId,
  );
  const ready =
    account !== null && name.trim() !== '' && (isWhatsApp ? templateId !== '' : body.trim() !== '');

  function save() {
    if (!account) return;
    setProblem(null);
    startTransition(async () => {
      const result = await createCampaignDraft({
        name,
        channelAccountId: account.id,
        channel: account.channel,
        ...(isWhatsApp ? { templateId } : { body }),
        ...(when ? { scheduledAt: new Date(when).toISOString() } : {}),
      });
      if (result.ok) router.push({ pathname: '/outreach', query: { campaign: result.id } });
      else setProblem(t(`error.${result.reason}`));
    });
  }

  if (accounts.length === 0) {
    return (
      <div className={drawer.drawerBody} data-testid="campaign-form">
        <p className={drawer.hint} data-testid="campaign-no-account">
          {t('noAccount')}
        </p>
        <Link href="/settings/channels" className={styles.formLink}>
          {t('connect')}
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="campaign-form">
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('from')}</span>
          <select
            className={drawer.box}
            value={accountId}
            data-testid="campaign-account"
            onChange={(e) => {
              setAccountId(e.target.value);
              setTemplateId('');
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        {isWhatsApp ? (
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('template')}</span>
            {forAccount.length === 0 ? (
              <span className={drawer.hint} data-testid="campaign-no-template">
                {t('noTemplate')}{' '}
                <Link
                  href={{ pathname: '/outreach/templates', query: { create: '1' } }}
                  className={styles.formLink}
                >
                  {t('newTemplate')}
                </Link>
              </span>
            ) : (
              <select
                className={drawer.box}
                value={templateId}
                data-testid="campaign-template"
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">{t('pickTemplate')}</option>
                {forAccount.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} · {tpl.language}
                  </option>
                ))}
              </select>
            )}
            <span className={drawer.hint}>{t('templateHint')}</span>
          </label>
        ) : (
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('message')}</span>
            <textarea
              className={drawer.box}
              rows={5}
              value={body}
              data-testid="campaign-body"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        )}

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('name')}</span>
          <input
            className={drawer.box}
            value={name}
            maxLength={120}
            placeholder={t('namePlaceholder')}
            data-testid="campaign-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('when')}</span>
          <input
            className={drawer.box}
            type="datetime-local"
            value={when}
            data-testid="campaign-when"
            onChange={(e) => setWhen(e.target.value)}
          />
          <span className={drawer.hint}>{t('whenHint')}</span>
        </label>
      </div>

      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.formSave}
          disabled={!ready || isPending}
          data-testid="campaign-save"
          onClick={save}
        >
          {isPending ? t('saving') : t('save')}
        </button>
        <Link href="/outreach" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.formProblem} role="alert" data-testid="campaign-problem">
            {problem}
          </span>
        ) : (
          <span className={drawer.drawerFootNote}>{t('draftNote')}</span>
        )}
      </footer>
    </>
  );
}
