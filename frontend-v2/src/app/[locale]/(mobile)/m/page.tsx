import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';

/** `/m` is the inbox: it is what the app opens to, and what a bare link means. */
export default async function Page() {
  redirect({ href: '/m/inbox', locale: await getLocale() });
}
