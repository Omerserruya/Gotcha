import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';

import { appPath } from '@/lib/base-path';

import { LinkFrame } from '../_link-frame/LinkFrame';
import { DeletionRequestPanel } from './DeletionRequestPanel';

/**
 * `/account-deletion` - ask for an account to be deleted, signed out (Google
 * Play's Data safety requires a web page for it; Omer, 2026-11-14). The proxy
 * lets it through without a session (`SIGNED_OUT_ROUTES`), on the product
 * origin with the product's CSP.
 *
 * ★★ RENDERED PER REQUEST (`connection()`), NEVER PRERENDERED. The CSP's
 *   script nonce is applied at render time; a page that reads nothing from
 *   the request is built as static HTML with NO nonce, and every one of its
 *   scripts is then refused. Found on dev (2026-11-14): the page drew, never
 *   hydrated, and its form fell back to a native GET - the address typed
 *   into the URL. jsdom passed it; only a real browser saw it.
 */
export default async function AccountDeletionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await connection();
  const { locale } = await params;
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
      <DeletionRequestPanel locale={locale} signInHref={appPath(`/${locale}/sign-in`)} />
    </LinkFrame>
  );
}
