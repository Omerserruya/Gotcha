import { loadTruth } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { TruthStep } from '@/features/onboarding/TruthStep';
import { pageMetadata } from '@/shell/page-metadata';

/** 00g - Onboarding · Source of truth (design 6). `?system=` is a tile chosen. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly system?: string; readonly preview?: string }>;
} = {}) {
  const params = await searchParams;
  const preview = isPreview(params);
  const system = params?.system ?? null;
  const read = await loadTruth();
  return (
    <OnboardingShell step="truth" preview={preview}>
      <TruthStep
        integrations={read.integrations}
        shopify={read.shopify}
        detected={read.detected}
        system={system}
        coreSystem={read.coreSystem}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.truth', 'onboarding');
