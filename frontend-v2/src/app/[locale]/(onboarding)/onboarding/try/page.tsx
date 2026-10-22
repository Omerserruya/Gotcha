import { getLocale } from 'next-intl/server';

import { loadTry } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { TryStep } from '@/features/onboarding/TryStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00h - Onboarding · Try it (design 6). */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly skipped?: string; readonly preview?: string }>;
} = {}) {
  const params = await searchParams;
  const preview = isPreview(params);
  const skippedCore = params?.skipped === '1';
  const questions = await loadTry(await getLocale());
  return (
    <OnboardingShell step="try" preview={preview}>
      <TryStep questions={questions} skippedCore={skippedCore} preview={preview} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.try', 'onboarding');
