import { MobileHome } from '@/features/mobile/home/MobileHome';
import { MobileAccountMenu } from '@/shell/mobile/MobileAccountMenu';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile Home: the day at a glance, who needs you, what GOTCHA did.
 *
 * ★ Its own bar (the mark and the wordmark), so the account menu is handed in
 *   here: the app may reach the shell, a feature may not.
 */
export default function Page() {
  return <MobileHome account={<MobileAccountMenu />} />;
}

export const generateMetadata = pageMetadata('primary.home');
