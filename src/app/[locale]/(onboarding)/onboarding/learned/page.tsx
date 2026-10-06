import { LearnedStep } from '@/features/onboarding/LearnedStep';
import { loadLearned } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { pageMetadata } from '@/shell/page-metadata';

/** 00f - Onboarding · What it learned (design 6). */
export default async function Page() {
  const read = await loadLearned();
  return (
    <OnboardingShell step="learned">
      <LearnedStep discovery={read.discovery} facts={read.facts} voice={read.voice} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.learned', 'onboarding');
