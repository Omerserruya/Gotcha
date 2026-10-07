import { getLocale } from 'next-intl/server';

import { loadTry } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { TryStep } from '@/features/onboarding/TryStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00h - Onboarding · Try it (design 6). */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly skipped?: string }>;
}) {
  const skippedCore = (await searchParams)?.skipped === '1';
  const questions = await loadTry(await getLocale());
  return (
    <OnboardingShell step="try">
      <TryStep questions={questions} skippedCore={skippedCore} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.try', 'onboarding');
