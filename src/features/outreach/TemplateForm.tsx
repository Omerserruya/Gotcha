'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import drawer from '@/design-system/styles/drawer.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import type { SendingAccount } from './CampaignForm';
import { createTemplate } from './create-actions';
import styles from './Outreach.module.css';

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;

/**
 * Meta's own rule for a template name: lowercase letters, digits and
 * underscores. Typed names are shaped as they go, so submitting later does
 * not fail on the name.
 */
export function templateName(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 512);
}

/**
 * 05c's "New template" - a local DRAFT (Omer, 2026-10-04). Submitting it to
 * Meta for review is a separate write and stays drawn until approved.
 */
export function TemplateForm({ accounts }: { readonly accounts: readonly SendingAccount[] }) {
  const t = useTranslations('templates.create');
  const router = useRouter();
  const whatsapp = accounts.filter((a) => a.channel === 'WHATSAPP');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('he');
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>('MARKETING');
  const [accountId, setAccountId] = useState(whatsapp[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const ready = name !== '' && body.trim() !== '';

  function save() {
    setProblem(null);
    startTransition(async () => {
      const result = await createTemplate({
        name,
        body,
        category,
        language,
        ...(accountId ? { channelAccountId: accountId } : {}),
        ...(footer.trim() ? { footer } : {}),
      });
      if (result.ok)
        router.push({ pathname: '/outreach/templates', query: { template: result.id } });
      else setProblem(t(`error.${result.reason}`));
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="template-form">
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('name')}</span>
          <input
            className={drawer.box}
            value={name}
            placeholder="order_ready_he"
            data-testid="template-name"
            onChange={(e) => setName(templateName(e.target.value))}
          />
          <span className={drawer.hint}>{t('nameHint')}</span>
        </label>

        <div className={drawer.pair}>
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('language')}</span>
            <select
              className={drawer.box}
              value={language}
              data-testid="template-language"
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="he">{t('lang.he')}</option>
              <option value="en">{t('lang.en')}</option>
              <option value="ar">{t('lang.ar')}</option>
            </select>
          </label>
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('category')}</span>
            <select
              className={drawer.box}
              value={category}
              data-testid="template-category"
              onChange={(e) => setCategory(e.target.value as (typeof TEMPLATE_CATEGORIES)[number])}
            >
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`cat.${c}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {whatsapp.length > 0 ? (
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('number')}</span>
            <select
              className={drawer.box}
              value={accountId}
              data-testid="template-account"
              onChange={(e) => setAccountId(e.target.value)}
            >
              {whatsapp.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('body')}</span>
          <textarea
            className={drawer.box}
            rows={6}
            value={body}
            maxLength={1024}
            data-testid="template-body"
            onChange={(e) => setBody(e.target.value)}
          />
          <span className={drawer.hint}>{t('bodyHint')}</span>
        </label>

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('footer')}</span>
          <input
            className={drawer.box}
            value={footer}
            maxLength={60}
            data-testid="template-footer"
            onChange={(e) => setFooter(e.target.value)}
          />
        </label>
      </div>

      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.formSave}
          disabled={!ready || isPending}
          data-testid="template-save"
          onClick={save}
        >
          {isPending ? t('saving') : t('save')}
        </button>
        <Link href="/outreach/templates" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.formProblem} role="alert" data-testid="template-problem">
            {problem}
          </span>
        ) : (
          <span className={drawer.drawerFootNote}>{t('draftNote')}</span>
        )}
      </footer>
    </>
  );
}
