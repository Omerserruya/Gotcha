'use client';

import { Plug } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { downloadFromPlatform } from '@/api/client/download';
import type { WidgetInstall, WooSite } from '@/api/contracts/website-widget';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { useRouter } from '@/i18n/navigation';

import styles from './Webchat.module.css';
import { removeWooSite, type WooRemove } from './woo-plugin-actions';

/**
 * Install · WooCommerce, by its plugin (woocommerce-plugin-v1, manual install
 * first - Omer, 2026-10-08): download the zip here, upload it in WordPress,
 * press "Connect to GOTCHA" there. Each site that connected is listed with
 * what its plugin last said (activated, deactivated, removed, the daily
 * heartbeat), and can be disconnected from here.
 *
 * A service before the plugin sends no `downloadUrl`: the row stays a status,
 * and the code below still works on a WooCommerce site.
 *
 * ⚠ The plugin's name is a placeholder until Omer names it (§7) - one key,
 *   `woo.pluginName`.
 */
export function WooPlugin({ woo }: { readonly woo: WidgetInstall['woocommerce'] }) {
  const t = useTranslations('channels.webchat.install');
  const tw = useTranslations('channels.webchat');
  // Only the platform's own path is fetched (through the BFF): never an address from elsewhere.
  const download = woo.downloadUrl?.startsWith('/api/')
    ? (woo.downloadUrl as `/api/${string}`)
    : null;

  if (!download) {
    return (
      <div className={styles.store} data-testid="webchat-woo">
        <span className={styles.storeMark} data-store="woo" aria-hidden="true">
          <Plug size={15} />
        </span>
        <span className={styles.toggleText}>
          <span>{t('woo')}</span>
          <span className={styles.rowHint}>{t('wooHint')}</span>
          <span className={styles.why}>{t('wooWhy')}</span>
        </span>
        <UnavailableAction
          label={t('wooButton')}
          tag={tw('comingSoon')}
          why={t('wooWhy')}
          testid="webchat-woo-action"
        />
      </div>
    );
  }
  return (
    <>
      <div className={styles.store} data-stack="" data-testid="webchat-woo">
        <div className={styles.storeLine}>
          <span className={styles.storeMark} data-store="woo" aria-hidden="true">
            <Plug size={15} />
          </span>
          <span className={styles.storeName}>{t('woo')}</span>
          <DownloadPlugin path={download} />
        </div>
        <div className={styles.storeBody}>
          <span className={styles.rowHint} data-testid="webchat-woo-steps">
            {t('wooPlugin.steps', { name: t('wooPlugin.pluginName') })}
          </span>
        </div>
      </div>
      {woo.sites.map((site) => (
        <WooSiteRow key={site.id} site={site} />
      ))}
    </>
  );
}

/**
 * The zip, through the BFF (an authenticated GET), saved under the platform's
 * own name. A refusal is said here - never a file of JSON named `.zip`.
 */
function DownloadPlugin({ path }: { readonly path: `/api/${string}` }) {
  const t = useTranslations('channels.webchat.install.wooPlugin');
  const [state, setState] = useState<'idle' | 'getting' | 'forbidden' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        className={styles.secondary}
        disabled={state === 'getting'}
        data-testid="webchat-woo-download"
        onClick={async () => {
          setState('getting');
          const got = await downloadFromPlatform(path);
          if (!got.ok) {
            setState(got.status === 403 ? 'forbidden' : 'failed');
            return;
          }
          const url = URL.createObjectURL(got.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'gotcha-for-woocommerce.zip';
          a.click();
          URL.revokeObjectURL(url);
          setState('idle');
        }}
      >
        {state === 'getting' ? t('downloading') : t('download')}
      </button>
      {state === 'forbidden' || state === 'failed' ? (
        <span
          className={styles.assignProblem}
          role="alert"
          data-testid="webchat-woo-download-failed"
        >
          {t(`downloadProblem.${state}`)}
        </span>
      ) : null}
    </>
  );
}

/** One WordPress site the plugin connected: what it last said, and Disconnect. */
function WooSiteRow({ site }: { readonly site: WooSite }) {
  const t = useTranslations('channels.webchat.install.wooPlugin');
  const format = useFormatter();
  const host = hostOf(site.siteUrl);
  const [asking, setAsking] = useState(false);
  return (
    <div
      className={styles.store}
      data-stack=""
      data-testid={`webchat-woo-site-${site.id}`}
      data-state={site.status}
    >
      <div className={styles.storeLine}>
        <span className={styles.storeMark} data-store="woo" aria-hidden="true">
          <Plug size={15} />
        </span>
        <span className={styles.storeName}>{t('site')}</span>
        {site.status === 'removed' ? null : (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setAsking(true)}
            data-testid={`webchat-woo-remove-${site.id}`}
          >
            {t('remove.button')}
          </button>
        )}
        <span
          className={styles.status}
          data-live={site.status === 'connected' ? '' : undefined}
          data-testid={`webchat-woo-status-${site.id}`}
        >
          {t(`tag.${site.status}`)}
        </span>
      </div>
      <div className={styles.storeBody}>
        <bdi dir="ltr" className={styles.domain} title={site.siteUrl}>
          {host}
        </bdi>
        <span className={styles.rowHint} data-testid={`webchat-woo-line-${site.id}`}>
          {t(`line.${site.status}`)}
          {site.lastSeenAt
            ? ` ${t('lastSeen', {
                when: format.dateTime(new Date(site.lastSeenAt), {
                  day: 'numeric',
                  month: 'short',
                }),
              })}`
            : ''}
          {site.pluginVersion ? ` ${t('version', { version: site.pluginVersion })}` : ''}
        </span>
      </div>
      {asking ? <RemoveSite site={site} host={host} onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

function RemoveSite({
  site,
  host,
  onClose,
}: {
  readonly site: WooSite;
  readonly host: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('channels.webchat.install.wooPlugin.remove');
  const router = useRouter();
  const [result, setResult] = useState<WooRemove | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent
        title={t('title', { host })}
        description={t('what')}
        data-testid="webchat-woo-remove-dialog"
      >
        {result && !result.ok ? (
          <p className={styles.assignProblem} role="alert" data-testid="webchat-woo-remove-failed">
            {t(`problem.${result.reason}`)}
          </p>
        ) : null}
        <span className={styles.assignActions}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {t('keep')}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={isPending}
            data-testid="webchat-woo-remove-yes"
            onClick={() =>
              startTransition(async () => {
                const done = await removeWooSite(site.id);
                setResult(done);
                if (done.ok || done.reason === 'gone') {
                  onClose();
                  router.refresh();
                }
              })
            }
          >
            {isPending ? t('removing') : t('yes')}
          </button>
        </span>
      </DialogContent>
    </Dialog>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
