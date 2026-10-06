import { loadTry } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { TryStep } from '@/features/onboarding/TryStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00h - Onboarding · Try it (design 6). */
export default async function Page() {
  const questions = await loadTry();
  return (
    <OnboardingShell step="try">
      <TryStep questions={questions} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.try', 'onboarding');
