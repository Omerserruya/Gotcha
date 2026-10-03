import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

/**
 * The old "One person" page. 12d is a drawer over People now, so the
 * address lands there, with the same person open.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly userId: string }>;
}) {
  const { userId } = await params;
  const locale = await getLocale();
  redirect({ href: { pathname: '/settings/people', query: { person: userId } }, locale });
}
