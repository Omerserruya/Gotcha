import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview, stepHref } from '@/features/onboarding/preview';
import { ReadingStep } from '@/features/onboarding/ReadingStep';
import { readScan } from '@/features/onboarding/scan-actions';
import { redirect } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 00e - Onboarding · Reading it, on the site job. Read from the start
 * (`since` 0), so a reload draws the whole feed and every chip at once. No
 * job was ever started: back to the address.
 */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams?: Promise<{ readonly preview?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  const preview = isPreview(query);
  const read = await readScan(0);
  if (!read.ok && read.reason === 'none') {
    redirect({ href: stepHref('/onboarding/website', preview), locale });
  }
  return (
    <OnboardingShell step="learn" screen="reading" preview={preview}>
      <ReadingStep initial={read.ok ? read.job : null} preview={preview} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.reading', 'onboarding');
