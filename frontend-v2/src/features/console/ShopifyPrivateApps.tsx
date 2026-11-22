'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  ENTITLEMENTS,
  isShopifyInstallLink,
  type ConsoleRefusal,
  type ConsoleRequest,
  type Entitlement,
  type PrivateAppsSettings,
} from '@/api/contracts/shopify-private-apps';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import styles from './Console.module.css';
import type { ShopifyPrivateAppsRead } from './load-shopify-private-apps';
import {
  saveShopifyPrivateAppsSettings,
  sendShopifyCustomAppLink,
  sendShopifyCustomAppNewLink,
  shopifyCustomAppStep,
  type ConsoleWrite,
} from './shopify-private-actions';

/**
 * "Shopify private apps" (Supervisor, 2026-11-22): the platform switch and its
 * entitlement, the merchants' requests, and each step on one - paste the
 * custom app and send its link, a new link, revoke, grant. Every step that
 * emails a merchant or changes their access asks first, inline.
 *
 * ★★ The client secret field is write-only: a password field, never filled
 *   from the server (which never sends it), cleared once the step is done.
 */
export function ShopifyPrivateApps({ read }: { readonly read: ShopifyPrivateAppsRead }) {
  const t = useTranslations('console.shopifyApps');
  return (
    <>
      {read.settings ? (
        <SettingsCard settings={read.settings} />
      ) : (
        <p className={styles.notice} data-testid="shopify-apps-settings-unread">
          {t('settingsUnread')}
        </p>
      )}
      <section className={styles.card} data-testid="shopify-apps-requests">
        <h2 className={styles.cardTitle}>{t('requestsTitle')}</h2>
        {read.requests === null ? (
          <p className={styles.notice} data-testid="shopify-apps-requests-unread">
            {t('requestsUnread')}
          </p>
        ) : read.requests.length === 0 ? (
          <p className={styles.quiet} data-testid="shopify-apps-requests-none">
            {t('requestsNone')}
          </p>
        ) : (
          <ul className={styles.list}>
            {read.requests.map((request) => (
              <RequestRow
                key={request.tenantId}
                request={request}
                manual={read.settings?.entitlement === 'manual'}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SettingsCard({ settings }: { readonly settings: PrivateAppsSettings }) {
  const t = useTranslations('console.shopifyApps');
  const [enabled, setEnabled] = useState(settings.enabled);
  const [entitlement, setEntitlement] = useState<Entitlement>(settings.entitlement);
  const [result, setResult] = useState<ConsoleWrite | null>(null);
  const [isPending, startTransition] = useTransition();
  const changed = enabled !== settings.enabled || entitlement !== settings.entitlement;
  return (
    <section className={styles.card} data-testid="shopify-apps-settings">
      <h2 className={styles.cardTitle}>{t('settingsTitle')}</h2>
      <label className={styles.controlRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          data-testid="shopify-apps-enabled"
        />
        {t('enabled')}
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('entitlementLabel')}</span>
        <select
          className={styles.select}
          value={entitlement}
          onChange={(event) => setEntitlement(event.target.value as Entitlement)}
          data-testid="shopify-apps-entitlement"
        >
          {ENTITLEMENTS.map((value) => (
            <option key={value} value={value}>
              {t(`entitlement.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.controlRow}>
        <Button
          variant="primary"
          size="sm"
          disabled={isPending || !changed}
          data-testid="shopify-apps-save"
          onClick={() =>
            startTransition(async () => {
              setResult(await saveShopifyPrivateAppsSettings({ enabled, entitlement }));
            })
          }
        >
          {t('save')}
        </Button>
        <Outcome result={result} done={t('saved')} />
      </div>
    </section>
  );
}

type Step = 'link' | 'newLink' | 'revoke' | 'grant';

function RequestRow({
  request,
  manual,
}: {
  readonly request: ConsoleRequest;
  readonly manual: boolean;
}) {
  const t = useTranslations('console.shopifyApps');
  const format = useFormatter();
  const [open, setOpen] = useState<Step | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState({
    clientId: '',
    clientSecret: '',
    installLink: '',
    linkExpiresAt: '',
  });
  const [result, setResult] = useState<ConsoleWrite | null>(null);
  const [isPending, startTransition] = useTransition();
  const id = request.tenantId;
  const shop = request.shopDomain ?? t('noShop');
  const workspace = request.tenantName ?? id;
  const day = (iso: string | null) => {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? null
      : format.dateTime(date, {
          day: 'numeric',
          month: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        });
  };
  const known = ['requested', 'link_sent', 'installed', 'revoked'].includes(request.status);

  const steps: Step[] = [
    ...(request.status === 'requested' ? (['link'] as const) : []),
    ...(request.status === 'link_sent' ? (['newLink'] as const) : []),
    ...(request.status === 'link_sent' || request.status === 'installed'
      ? (['revoke'] as const)
      : []),
    // Grant (beaecd42): manual entitlement, INSTALLED rows only - it enables the Shopify features.
    ...(manual && request.status === 'installed' ? (['grant'] as const) : []),
  ];

  const ready =
    open === 'link'
      ? form.clientId.trim() !== '' &&
        form.clientSecret.trim() !== '' &&
        isShopifyInstallLink(form.installLink)
      : open === 'newLink'
        ? isShopifyInstallLink(form.installLink)
        : true;
  const linkWrong = form.installLink.trim() !== '' && !isShopifyInstallLink(form.installLink);

  const go = () =>
    startTransition(async () => {
      const done =
        open === 'link'
          ? await sendShopifyCustomAppLink(id, form)
          : open === 'newLink'
            ? await sendShopifyCustomAppNewLink(id, form.installLink, form.linkExpiresAt)
            : open
              ? await shopifyCustomAppStep(id, open)
              : null;
      setResult(done);
      setConfirming(false);
      // The secret never stays in the page once it was sent - nor after a refusal.
      setForm((now) => ({ ...now, clientSecret: '' }));
      if (done?.ok) setOpen(null);
    });

  return (
    <li className={styles.listRow} data-testid={`shopify-app-${id}`} data-status={request.status}>
      <div>
        <bdi dir="ltr" className={styles.name}>
          {shop}
        </bdi>{' '}
        <span className={styles.slug}>{workspace}</span>
      </div>
      <p className={styles.quiet} data-testid={`shopify-app-${id}-status`}>
        {known ? t(`status.${request.status as 'requested'}`) : request.status}
        {request.requestedAt && day(request.requestedAt)
          ? ` · ${t('requestedOn', { day: day(request.requestedAt)! })}`
          : null}
        {request.status === 'link_sent' && day(request.linkExpiresAt)
          ? ` · ${t('expiresOn', { day: day(request.linkExpiresAt)! })}`
          : null}
        {request.status === 'installed' && day(request.installedAt)
          ? ` · ${t('installedOn', { day: day(request.installedAt)! })}`
          : null}
        {request.clientId ? (
          <>
            {' · '}
            {t('clientId')} <bdi dir="ltr">{request.clientId}</bdi>
          </>
        ) : null}
      </p>

      {open === null ? (
        <div className={styles.controlRow}>
          {steps.map((step) => (
            <Button
              key={step}
              size="sm"
              variant={step === 'revoke' ? 'danger' : 'secondary'}
              data-testid={`shopify-app-${id}-${step}`}
              onClick={() => {
                setResult(null);
                setConfirming(false);
                setOpen(step);
              }}
            >
              {t(`step.${step}`)}
            </Button>
          ))}
        </div>
      ) : (
        <div className={styles.confirm} data-testid={`shopify-app-${id}-${open}-form`}>
          {open === 'link' ? (
            <>
              <Input
                label={t('field.clientId')}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={form.clientId}
                onChange={(event) => setForm((now) => ({ ...now, clientId: event.target.value }))}
                data-testid={`shopify-app-${id}-client-id`}
              />
              <Input
                label={t('field.clientSecret')}
                hint={t('field.clientSecretHint')}
                type="password"
                dir="ltr"
                autoComplete="new-password"
                spellCheck={false}
                value={form.clientSecret}
                onChange={(event) =>
                  setForm((now) => ({ ...now, clientSecret: event.target.value }))
                }
                data-testid={`shopify-app-${id}-client-secret`}
              />
            </>
          ) : null}
          {open === 'link' || open === 'newLink' ? (
            <>
              <Input
                label={t('field.installLink')}
                hint={t('field.installLinkHint')}
                dir="ltr"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={form.installLink}
                error={linkWrong ? t('field.installLinkWrong') : undefined}
                onChange={(event) =>
                  setForm((now) => ({ ...now, installLink: event.target.value }))
                }
                data-testid={`shopify-app-${id}-install-link`}
              />
              <Input
                label={t('field.expires')}
                hint={t('field.expiresHint')}
                type="date"
                value={form.linkExpiresAt}
                onChange={(event) =>
                  setForm((now) => ({ ...now, linkExpiresAt: event.target.value }))
                }
                data-testid={`shopify-app-${id}-expires`}
              />
            </>
          ) : null}

          {confirming ? (
            <p className={styles.confirmSentence} data-testid={`shopify-app-${id}-confirm`}>
              {t(`confirm.${open}`, { shop, workspace })}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            {confirming ? (
              <Button
                size="sm"
                variant={open === 'revoke' ? 'danger' : 'primary'}
                disabled={isPending}
                data-testid={`shopify-app-${id}-go`}
                onClick={go}
              >
                {t(`go.${open}`)}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={open === 'revoke' ? 'danger' : 'primary'}
                disabled={!ready}
                data-testid={`shopify-app-${id}-next`}
                onClick={() => setConfirming(true)}
              >
                {t(`step.${open}`)}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={isPending}
              data-testid={`shopify-app-${id}-cancel`}
              onClick={() => {
                setConfirming(false);
                setOpen(null);
                setForm({ clientId: '', clientSecret: '', installLink: '', linkExpiresAt: '' });
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      <Outcome result={result} done={t('done')} />
    </li>
  );
}

function Outcome({
  result,
  done,
}: {
  readonly result: ConsoleWrite | null;
  readonly done: string;
}) {
  const t = useTranslations('console.shopifyApps');
  if (!result) return null;
  if (result.ok && result.emailed === false) {
    // Saved, but the email did not go out: said, never "done".
    return (
      <p className={styles.refused} role="alert" data-testid="shopify-apps-not-emailed">
        {t('notEmailed')}
      </p>
    );
  }
  return result.ok ? (
    <p className={styles.done} role="status" data-testid="shopify-apps-done">
      {done}
    </p>
  ) : (
    <p className={styles.refused} role="alert" data-testid="shopify-apps-refused">
      {t(`refused.${result.reason satisfies ConsoleRefusal}`)}
    </p>
  );
}
