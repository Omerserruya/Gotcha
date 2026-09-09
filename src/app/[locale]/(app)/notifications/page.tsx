import { NotificationsScreen } from '@/features/notifications/NotificationsScreen';
import { pageMetadata } from '@/shell/page-metadata';

export default function Page() {
  return <NotificationsScreen />;
}

export const generateMetadata = pageMetadata('title', 'notifications');
