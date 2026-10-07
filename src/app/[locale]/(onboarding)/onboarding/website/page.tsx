import { loadWebsiteStep } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { WebsiteStep } from '@/features/onboarding/WebsiteStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00d - Onboarding · Your website (design 6). */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const read = await loadWebsiteStep();
  return (
    <OnboardingShell step="website" preview={preview}>
      <WebsiteStep
        guess={read.guess}
        email={read.email}
        business={read.business}
        discovery={read.discovery}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.website', 'onboarding');
