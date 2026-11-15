'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import type { EmbeddedSignupLaunch } from '@/api/contracts/whatsapp-connect';
import { Button } from '@/design-system/primitives/button/Button';
import { CenteredLoader } from '@/design-system/primitives/loader/Loader';
import { useRouter } from '@/i18n/navigation';

import { useMetaCode, type CodeExchange } from '../../channels/signup/use-meta-code';
import consoleStyles from '../Console.module.css';
import { connectPlatformNumber, type PlatformWrite } from './platform-whatsapp-actions';
import styles from './PlatformWhatsApp.module.css';

/**
 * The number from Meta's window, connected as GOTCHA's own. A WABA is sent
 * only when Meta named exactly one; with several, the route asks the person
 * to pick (422 `choose_one_number`) rather than this guessing.
 */
const connect: CodeExchange<PlatformWrite> = (code, assets) =>
  connectPlatformNumber(code, {
    wabaId: assets.wabaIds?.length === 1 ? assets.wabaIds[0] : undefined,
    phoneNumberId: assets.phoneNumberId,
  });

/**
 * Connect (or connect again) GOTCHA's alerts number: the tenants' own Meta
 * window and launcher (`useMetaCode`), the platform's own exchange. Nothing
 * is said connected until the route says so and the page is read again.
 */
export function PlatformConnect({
  launch,
  again,
}: {
  readonly launch: EmbeddedSignupLaunch | null;
  /** Token expired: the same window, said as a repair. */
  readonly again: boolean;
}) {
  const t = useTranslations('console.platformWhatsApp');
  const router = useRouter();
  const meta = useMetaCode<PlatformWrite>(launch?.appId ?? '', connect);
  const result = meta.result;

  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const busy = meta.stage !== 'idle';
  const notConfigured = !launch?.configured;

  return (
    <div className={consoleStyles.action} data-testid="platform-connect">
      {/* A new number's rules; connecting the same number again needs none of them. */}
      {again ? null : (
        <p className={styles.quiet} data-testid="platform-connect-needs">
          {t('connect.needs')}
        </p>
      )}
      <Button
        variant="primary"
        disabled={notConfigured || meta.sdk !== 'ready' || busy}
        title={notConfigured ? t('connect.problem.notConfigured') : undefined}
        data-testid="platform-connect-start"
        onClick={() => meta.start(launch)}
      >
        {again ? t('connect.again') : t('connect.action')}
        <ExternalLink size={13} aria-hidden="true" />
      </Button>
      {busy ? (
        <div data-testid="platform-connect-waiting">
          <CenteredLoader
            size={24}
            minHeight={48}
            label={meta.stage === 'reading' ? t('connect.reading') : t('connect.waiting')}
          />
          <p className={styles.quiet}>
            {meta.stage === 'reading' ? t('connect.reading') : t('connect.waiting')}
          </p>
        </div>
      ) : null}
      {notConfigured ? (
        <p className={consoleStyles.refused} data-testid="platform-connect-not-configured">
          {t('connect.problem.notConfigured')}
        </p>
      ) : meta.sdk === 'unavailable' ? (
        <p className={consoleStyles.refused} role="alert" data-testid="platform-connect-sdk">
          {t('connect.problem.unavailable')}
        </p>
      ) : null}
      {meta.problem ? (
        <p className={consoleStyles.refused} role="alert" data-testid="platform-connect-problem">
          {t(`connect.problem.${meta.problem}`)}
        </p>
      ) : null}
      {result && !result.ok ? (
        <p className={consoleStyles.refused} role="alert" data-testid="platform-connect-refused">
          {t(`refusal.${result.reason}`)}
        </p>
      ) : null}
      {result?.ok ? (
        <p className={consoleStyles.done} role="status" data-testid="platform-connect-done">
          {t('connect.done')}
        </p>
      ) : null}
    </div>
  );
}
