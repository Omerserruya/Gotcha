import { getLocale, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { channelsPhrase, reachableChannels } from '@/features/onboarding/channel-reach';
import { GoLiveStep } from '@/features/onboarding/GoLiveStep';
import { readLearned } from '@/features/onboarding/learned-actions';
import { loadChannelsStep, loadSavedStep } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { ReviewStep, ReviewUnavailable } from '@/features/onboarding/ReviewStep';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Onboarding v2 · step 4, check and go live: what was learned, corrected in
 * place; then the one press, and a sandboxed question to the employee.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const [read, channels, saved, locale, tc] = await Promise.all([
    readLearned(),
    loadChannelsStep(),
    loadSavedStep(),
    getLocale(),
    getTranslations('channels'),
  ]);
  const reachable = reachableChannels(channels.channels, channels.install);
  // The phrase is built here, once: the same text on the server and in the browser.
  const reach =
    reachable === null
      ? null
      : channelsPhrase(
          reachable.map((each) => channelName(each, tc) ?? each),
          locale,
        );
  return (
    <OnboardingShell step="live" screen="live" preview={preview}>
      {read.ok ? (
        <ReviewStep
          initial={read.learned}
          preview={preview}
          after={<GoLiveStep reach={reach} current={saved?.employee ?? null} preview={preview} />}
        />
      ) : (
        <ReviewUnavailable reason={read.reason} preview={preview} />
      )}
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.live', 'onboarding');
