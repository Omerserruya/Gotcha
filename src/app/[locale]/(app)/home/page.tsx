import { HomeScreen } from '@/features/home/HomeScreen';
import { pageMetadata } from '@/shell/page-metadata';

export default function Page() {
  return <HomeScreen />;
}

export const generateMetadata = pageMetadata('primary.home');
