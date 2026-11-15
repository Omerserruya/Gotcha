import { getTranslations } from 'next-intl/server';

import { appPath } from '@/lib/base-path';

import { LinkFrame } from '../../_link-frame/LinkFrame';
import { DeletionConfirmPanel } from './DeletionConfirmPanel';

/**
 * `/account-deletion/confirm?token=` - the deletion email's link, signed out.
 *
 * ★★ The token is read and handed to the panel; NOTHING is sent on load.
 *   Only the person's press confirms (mail scanners open links).
 */
export default async function AccountDeletionConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { locale } = await params;
  const { token: raw } = await searchParams;
  const token = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  const t = await getTranslations('auth.accountDeletion');
  return (
    <LinkFrame
      editorial={{
        eyebrow: t('editorial.eyebrow'),
        headline: t('editorial.headline'),
        support: t('editorial.support'),
        status: t('editorial.status'),
      }}
    >
      <DeletionConfirmPanel
        token={token}
        requestHref={appPath(`/${locale}/account-deletion`)}
        signInHref={appPath(`/${locale}/sign-in`)}
      />
    </LinkFrame>
  );
}
