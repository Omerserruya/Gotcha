import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';

/**
 * The old notifications page. 01d is a panel over Home now, so the address
 * lands there, open.
 */
export default async function Page() {
  const locale = await getLocale();
  redirect({ href: { pathname: '/home', query: { notifications: '1' } }, locale });
}
