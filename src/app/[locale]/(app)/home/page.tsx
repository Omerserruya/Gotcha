import { HomeScreen } from '@/features/home/HomeScreen';
import { isKind } from '@/features/notifications/notification-kind';
import { NotificationsPanel } from '@/features/notifications/NotificationsPanel';
import { pageMetadata } from '@/shell/page-metadata';

export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    /** 01d: the notifications panel over Home, and its filter. */
    readonly notifications?: string;
    readonly kind?: string;
    /** 19's ASK: fills the command box. */
    readonly ask?: string;
  }>;
} = {}) {
  const params = (await searchParams) ?? {};
  return (
    <>
      <HomeScreen ask={(params.ask ?? '').slice(0, 500)} />
      {params.notifications === '1' ? (
        <NotificationsPanel kind={isKind(params.kind) ? params.kind : null} />
      ) : null}
    </>
  );
}

export const generateMetadata = pageMetadata('primary.home');
