import { loadShopifyPending } from '@/features/capabilities/load-capabilities';
import { loadDiscovery, loadSystems } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { systemsReturn, type SystemsReturnQuery } from '@/features/onboarding/systems-return';
import { SystemsStep } from '@/features/onboarding/SystemsStep';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Onboarding v2 · step 2, connect your systems - and where a connect started
 * here comes back to (`flow=onboarding_systems`): `?system=&connected=1`,
 * `?system=&error=`, Shopify's `pending=1` and `billing=verify&shop=`.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<SystemsReturnQuery & { readonly preview?: string }>;
} = {}) {
  const params = await searchParams;
  const preview = isPreview(params);
  const returned = systemsReturn(params);
  const [read, discovery, shopifyPending] = await Promise.all([
    loadSystems(),
    // The site the scan read: WooCommerce's store address, so connecting is one click.
    loadDiscovery(),
    returned?.kind === 'pending' ? loadShopifyPending() : null,
  ]);
  return (
    <OnboardingShell step="systems" screen="systems" preview={preview}>
      <SystemsStep
        suggestions={read.suggestions}
        integrations={read.integrations}
        shopify={read.shopify}
        site={discovery?.websiteDomain ?? null}
        returned={returned}
        shopifyPending={shopifyPending}
        preview={preview}
      />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.systems', 'onboarding');
