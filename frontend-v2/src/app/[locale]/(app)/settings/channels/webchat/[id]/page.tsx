import { redirect } from '@/i18n/navigation';

/**
 * The web chat's old address. There is one widget for the workspace now
 * (the Website widget), so every web chat id opens it, on the tab asked for.
 */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
  readonly searchParams?: Promise<{ readonly tab?: string }>;
}) {
  const { locale } = await params;
  const tab = (await searchParams)?.tab;
  redirect({
    href: { pathname: '/settings/channels/website', query: tab ? { tab } : {} },
    locale,
  });
}
