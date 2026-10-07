import { loadResumeState } from '@/features/onboarding/load-onboarding';
import { isPreview, stepHref } from '@/features/onboarding/preview';
import { redirect } from '@/i18n/navigation';
import { resumeStep } from '@/shell/workspace-gate';

/**
 * Onboarding resumes where it really is: no read yet → the website; a read
 * running → reading; read → what it learned, or - with a core system
 * connected - trying it. Every product route sends an admin here.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ readonly preview?: string }>;
}) {
  const { locale } = await params;
  const step = resumeStep(await loadResumeState());
  // A preview stays one: the step it resumes at keeps the flag.
  redirect({ href: stepHref(`/onboarding/${step}`, isPreview(await searchParams)), locale });
}
