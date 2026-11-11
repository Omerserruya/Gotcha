import { channelLandingOf, messengerPickOf } from '@/features/channels/landing';
import { loadMessengerPages } from '@/features/channels/messenger-actions';
import { ChannelsStep } from '@/features/onboarding/ChannelsStep';
import { loadChannelsStep, loadInstallWays } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Onboarding v2 · step 3, channels: connect where customers write, or skip.
 *
 * ★ A connect started here comes back here (`flow=onboarding_channels`,
 *   backend 2c1653b0) with the query 13 reads, and is read the same way:
 *   `connected=&count=[&pending=1&reason=]`, `platform=&error=`, and
 *   Messenger's `pick=1&platform=messenger&session=` with its Pages.
 * ★ The website row offers the way that fits the site first (the platform
 *   the read found); a preview opens no panel, so it reads none of that.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly preview?: string;
    readonly connected?: string;
    readonly count?: string;
    readonly pending?: string;
    readonly platform?: string;
    readonly error?: string;
    readonly reason?: string;
    readonly pick?: string;
    readonly session?: string;
  }>;
} = {}) {
  const params = (await searchParams) ?? {};
  const preview = isPreview(params);
  // A preview connects nothing, so it has no way back to read either.
  const landing = preview ? null : channelLandingOf(params);
  const pick = preview ? null : messengerPickOf(params);
  const [read, pages, ways] = await Promise.all([
    loadChannelsStep(),
    pick ? loadMessengerPages(pick.session) : Promise.resolve(null),
    preview ? Promise.resolve({ detected: null, shopify: null }) : loadInstallWays(),
  ]);
  return (
    <OnboardingShell step="channels" screen="channels" preview={preview}>
      <ChannelsStep
        channels={read.channels}
        install={read.install}
        config={read.config}
        detected={ways.detected}
        shopify={ways.shopify}
        landing={landing}
        pick={pick && pages ? { session: pick.session, read: pages } : null}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.channels', 'onboarding');
