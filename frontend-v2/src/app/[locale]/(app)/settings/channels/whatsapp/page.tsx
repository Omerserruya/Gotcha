import { redirect } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 13b is a panel over Channels now (`/settings/channels?panel=whatsapp`), not
 * a page of its own. This address stays, so a saved link or a bookmark still
 * opens it.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: { pathname: '/settings/channels', query: { panel: 'whatsapp' } }, locale });
}

export const generateMetadata = pageMetadata('settings.whatsapp');
