import { ChannelsStep } from '@/features/onboarding/ChannelsStep';
import { loadChannelsStep } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { pageMetadata } from '@/shell/page-metadata';

/** Onboarding v2 · step 3, channels: connect where customers write, or skip. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly preview?: string }>;
} = {}) {
  const preview = isPreview(await searchParams);
  const read = await loadChannelsStep();
  return (
    <OnboardingShell step="channels" screen="channels" preview={preview}>
      <ChannelsStep
        channels={read.channels}
        install={read.install}
        config={read.config}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.channels', 'onboarding');
