'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  countryName,
  displayHost,
  fieldOrigin,
  industryReading,
  type Workspace,
} from '@/api/contracts/workspace';
import { Link } from '@/i18n/navigation';
import drawer from '@/design-system/styles/drawer.module.css';

import { saveWorkspaceFacts } from './actions';
import styles from './Workspace.module.css';
import type { WebsiteScan } from './load-workspace';

/**
 * 11b, measured: the business's facts as one form in a drawer — opened from
 * the Website, What you sell and Address rows.
 *
 * `PATCH /workspace` takes name, description and address here. The website,
 * industry and country come from the scan and onboarding and are not on its
 * allow-list, and nothing stores a note for visitors: those are drawn, not
 * live, and say so on their titles.
 */
export function BusinessDrawer({
  workspace,
  scan = null,
}: {
  readonly workspace: Workspace;
  /** 11b's website line — what the scan read, and what else it found. */
  readonly scan?: WebsiteScan | null;
}) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  const [name, setName] = useState(workspace.name ?? '');
  const [description, setDescription] = useState(workspace.description ?? '');
  const [address, setAddress] = useState(workspace.address ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  /** "3 days ago", in the reader's language. */
  const ago = (days: number) =>
    new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const fromWebsite = (field: string) =>
    fieldOrigin(workspace, field) === 'scan' ? (
      <span className={styles.fromWebsite}>{t('provenance.origin.scan')}</span>
    ) : null;

  function save() {
    setProblem(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveWorkspaceFacts(
        { name: name.trim(), description: description.trim(), address: address.trim() || null },
        workspace.updatedAt ?? null,
      );
      if (result.ok) setSaved(true);
      else
        setProblem(
          result.reason === 'stale'
            ? t('stale')
            : result.reason === 'invalid'
              ? (Object.values(result.fields)[0] ?? t('failed'))
              : t('failed'),
        );
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="business-drawer">
        <div className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('fact.website')}</span>
          <span className={styles.websiteRow}>
            <span
              className={drawer.box}
              aria-disabled="true"
              title={t('website.readOnly')}
              data-testid="business-website"
            >
              {workspace.websiteDomain ? displayHost(workspace.websiteDomain) : '—'}
            </span>
            {/*
              The rescan is the Workspace page's (POST /workspace/scan): it
              answers with what it applied and what it only offers, and that
              conversation lives in its panel — so this leads there.
            */}
            <Link
              href={{ pathname: '/settings/workspace', hash: 'scan' }}
              className={styles.scanAgainLink}
              data-testid="business-scan-again"
            >
              {t('website.scanAgain')}
            </Link>
          </span>
          {scan && scan.pagesRead > 0 ? (
            <span className={drawer.hint} data-testid="business-scan-line">
              {[
                t('website.pagesRead', { count: scan.pagesRead }),
                scan.daysAgo === null ? t('website.reading') : ago(scan.daysAgo),
              ].join(' ')}
              {scan.topics.length > 0 ? ` · ${scan.topics.join(', ')}` : ''}
            </span>
          ) : null}
          {scan && scan.alsoFound.length > 0 ? (
            <span className={styles.alsoFound} data-testid="business-also-found">
              <span className={styles.alsoFoundLabel}>{t('website.alsoFound')}</span>
              {scan.alsoFound.map((item) => (
                <span key={`${item.kind}-${item.name}`} className={styles.alsoFoundChip}>
                  {item.kind === 'store' ? t('website.store', { name: item.name }) : item.name}
                </span>
              ))}
            </span>
          ) : null}
        </div>

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>
            {t('fact.name')}
            {fromWebsite('organizationName')}
          </span>
          <input
            className={drawer.box}
            value={name}
            maxLength={200}
            data-testid="business-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>
            {t('fact.description')}
            {fromWebsite('businessDescription')}
          </span>
          <textarea
            className={drawer.box}
            value={description}
            maxLength={2000}
            data-testid="business-description"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className={drawer.pair}>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('business.industry')}</span>
            <span className={drawer.box} aria-disabled="true" title={t('business.notHere')}>
              {(() => {
                const industry = industryReading(workspace.industry);
                return industry === null
                  ? '—'
                  : 'code' in industry
                    ? t(`business.industryName.${industry.code}`)
                    : industry.text;
              })()}
            </span>
          </div>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('business.country')}</span>
            <span className={drawer.box} aria-disabled="true" title={t('business.notHere')}>
              {countryName(workspace.country, locale) ?? '—'}
            </span>
          </div>
        </div>

        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>
            {t('fact.address')}
            {fromWebsite('address')}
          </span>
          <input
            className={drawer.box}
            value={address}
            maxLength={300}
            data-testid="business-address"
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>

        <div className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('business.note')}</span>
          <span
            className={drawer.box}
            aria-disabled="true"
            title={t('business.noNote')}
            data-testid="business-note"
          >
            —
          </span>
        </div>

        <p className={drawer.hint}>
          <span className={styles.fromWebsite}>{t('provenance.origin.scan')}</span>{' '}
          {t('business.legend')}
        </p>
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-business"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? t('saving') : t('business.save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote} data-testid="business-problem" data-note-kind="problem">
            {problem}
          </span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="business-saved">
            {t('saved')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
