import { loadReading } from '@/features/onboarding/load-onboarding';
import { OnboardingShell } from '@/features/onboarding/OnboardingShell';
import { isPreview } from '@/features/onboarding/preview';
import { ReadingStep } from '@/features/onboarding/ReadingStep';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 00e - Onboarding · Reading it (design 6). `?since=` is when 00d started this
 * read: a row older than that is the last read, not this one.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly since?: string; readonly preview?: string }>;
} = {}) {
  const params = await searchParams;
  const preview = isPreview(params);
  const raw = params?.since ?? null;
  const since = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null;
  const initial = await loadReading().catch(() => null);
  return (
    <OnboardingShell step="reading" preview={preview}>
      <ReadingStep initial={initial} since={since} preview={preview} />
    </OnboardingShell>
  );
}

export const generateMetadata = pageMetadata('steps.reading', 'onboarding');
