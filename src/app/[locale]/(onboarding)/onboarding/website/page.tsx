import { loadWebsiteStep } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { WebsiteStep } from '@/features/onboarding/WebsiteStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00d - Onboarding · Your website (design 6). */
export default async function Page() {
  const read = await loadWebsiteStep();
  return (
    <OnboardingShell step="website">
      <WebsiteStep
        guess={read.guess}
        email={read.email}
        business={read.business}
        discovery={read.discovery}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.website', 'onboarding');
