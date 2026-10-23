import { isPreview, stepHref } from '@/features/onboarding/preview';
import { redirect } from '@/i18n/navigation';

/** The old 00g ("source of truth") is step 2 now: connect your systems. Old links still land. */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams?: Promise<{ readonly preview?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  redirect({ href: stepHref('/onboarding/systems', isPreview(query)), locale });
}
