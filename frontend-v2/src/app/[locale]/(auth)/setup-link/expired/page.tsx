import { getTranslations } from 'next-intl/server';

import { setupLinkReason } from '@/features/setup-link/reasons';
import { appPath } from '@/lib/base-path';

import { LinkFrame } from '../../_link-frame/LinkFrame';
import { SetupLinkPanel } from './SetupLinkPanel';

/**
 * `/setup-link/expired?reason=&t=` - where `GET /api/auth/setup/:token`
 * (services/auth setup-link.ts:114) sends a link it could not redeem.
 * Opened signed out: the person has no password yet (`SIGNED_OUT_ROUTES`).
 */
export default async function SetupLinkExpiredPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ reason?: string | string[]; t?: string | string[] }>;
}) {
  const { locale } = await params;
  const { reason, t: rawToken } = await searchParams;
  const t = await getTranslations('auth.setupLink');
  const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;

  return (
    <LinkFrame
      editorial={{
        eyebrow: t('editorial.eyebrow'),
        headline: t('editorial.headline'),
        support: t('editorial.support'),
        status: t('editorial.status'),
      }}
    >
      <SetupLinkPanel
        reason={setupLinkReason(reason)}
        token={token}
        signInHref={appPath(`/${locale}/sign-in`)}
      />
    </LinkFrame>
  );
}
