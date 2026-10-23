import { readLearned } from '@/features/onboarding/learned-actions';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { ReviewStep, ReviewUnavailable } from '@/features/onboarding/ReviewStep';
import { pageMetadata } from '@/shell/page-metadata';

/** Onboarding v2 · step 4, check and go live: what was learned, corrected in place. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const read = await readLearned();
  return (
    <OnboardingShell step="live" screen="live" preview={preview}>
      {read.ok ? (
        <ReviewStep initial={read.learned} preview={preview} />
      ) : (
        <ReviewUnavailable reason={read.reason} preview={preview} />
      )}
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.live', 'onboarding');
