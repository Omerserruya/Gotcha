import { redirect } from '@/i18n/navigation';

/**
 * Settings has no page of its own.
 *
 * The design's first Settings screen IS Workspace - there is no landing page
 * above the sections, and an index listing them would only repeat the sidebar
 * standing beside it.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: '/settings/workspace', locale });
}
