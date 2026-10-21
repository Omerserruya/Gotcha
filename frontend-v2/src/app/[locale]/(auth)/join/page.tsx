import { getTranslations } from 'next-intl/server';

import { Text } from '@/design-system/primitives/text/Text';
import { loadInvitation } from '@/features/join/load-invitation';
import { appPath } from '@/lib/base-path';

import { LinkFrame } from '../_link-frame/LinkFrame';
import recover from '../recover/Recover.module.css';
import { JoinPanel } from './JoinPanel';

/**
 * `/join?token=` - an invitation to a workspace, opened signed out.
 *
 * Legacy `frontend/src/app/join/page.tsx`, read on the server instead of in an
 * effect: the invitation is fetched before anything is drawn, so there is no
 * spinner state, and a link that cannot be used says so without JavaScript.
 *
 * The link is built by services/auth (onboarding.ts:2977, `invite-link`);
 * the proxy lets it through without a session (`SIGNED_OUT_ROUTES`).
 */
export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { locale } = await params;
  const { token: raw } = await searchParams;
  const token = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  const t = await getTranslations('auth.join');
  const read = await loadInvitation(token);
  const signInHref = appPath(`/${locale}/sign-in`);

  const editorial = {
    eyebrow: t('editorial.eyebrow'),
    headline: t('editorial.headline'),
    support: t('editorial.support'),
    status: t('editorial.status'),
  };

  if (read.state === 'valid' && token) {
    return (
      <LinkFrame editorial={editorial}>
        <JoinPanel token={token} invitation={read.invitation} signInHref={signInHref} />
      </LinkFrame>
    );
  }

  return (
    <LinkFrame editorial={editorial}>
      <div className={recover.done} data-testid={`join-${read.state}`}>
        <Text role="title" as="h1">
          {t(`${read.state}.title`)}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t(`${read.state}.body`)}
        </Text>
        {read.state === 'unreachable' && token ? (
          // The same link again: the read is what failed, not the invitation.
          <a
            className={recover.back}
            href={appPath(`/${locale}/join?token=${encodeURIComponent(token)}`)}
            data-testid="join-retry"
          >
            {t('unreachable.retry')}
          </a>
        ) : null}
        <a className={recover.back} href={signInHref}>
          {t('signIn')}
        </a>
      </div>
    </LinkFrame>
  );
}
