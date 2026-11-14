import { loadResumeFacts } from '@/features/onboarding/load-onboarding';
import { isPreview, stepHref } from '@/features/onboarding/preview';
import { resumeAt } from '@/features/onboarding/resume-v2';
import { redirect } from '@/i18n/navigation';

/**
 * Onboarding resumes where it really is: the step saved on Continue/Skip,
 * unless it is past what the server proves (resume-v2). A site job that
 * could not be read proves nothing either way: the saved step, else reading
 * (which reads again, and sends a workspace with no job to the address).
 * Every product route sends an admin here.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ readonly preview?: string }>;
}) {
  const { locale } = await params;
  const facts = await loadResumeFacts();
  const step =
    facts.job === 'unread' ? (facts.saved ?? 'reading') : resumeAt({ ...facts, job: facts.job });
  // A preview stays one: the step it resumes at keeps the flag.
  redirect({ href: stepHref(`/onboarding/${step}`, isPreview(await searchParams)), locale });
}
