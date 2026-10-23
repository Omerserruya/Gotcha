import { loadSystems } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { SystemsStep } from '@/features/onboarding/SystemsStep';
import { pageMetadata } from '@/shell/page-metadata';

/** Onboarding v2 · step 2, connect your systems (00g's card, per suggestion). */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const read = await loadSystems();
  return (
    <OnboardingShell step="systems" screen="systems" preview={preview}>
      <SystemsStep
        suggestions={read.suggestions}
        integrations={read.integrations}
        shopify={read.shopify}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.systems', 'onboarding');
