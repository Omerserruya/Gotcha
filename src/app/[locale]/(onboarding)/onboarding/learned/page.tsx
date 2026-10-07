import { LearnedStep } from '@/features/onboarding/LearnedStep';
import { loadLearned } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { pageMetadata } from '@/shell/page-metadata';

/** 00f - Onboarding · What it learned (design 6). */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const read = await loadLearned();
  return (
    <OnboardingShell step="learned" preview={preview}>
      <LearnedStep
        discovery={read.discovery}
        facts={read.facts}
        voice={read.voice}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.learned', 'onboarding');
