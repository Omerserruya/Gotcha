import { getTranslations } from 'next-intl/server';

import { loadAnswerWords } from '@/features/home/load-answer-words';
import { MobileAsk } from '@/features/mobile/home/MobileAsk';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * "Ask GOTCHA" on the phone, full screen: Home's ask bar opens it, and its
 * address carries the thread (`?thread=`), as the website's Home does.
 *
 * ★ The answer's chrome in every language a turn can be in
 *   (`loadAnswerWords`), as the desktop Home sends it.
 */
export default async function Page() {
  const t = await getTranslations('mobile.home.askScreen');
  const answerWords = await loadAnswerWords();
  return (
    <div className={ui.screen} data-testid="mobile-ask-screen">
      <MobileBar back={{ href: '/m/home', label: t('back') }} title={t('title')} />
      <MobileAsk answerWords={answerWords} />
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.home');
