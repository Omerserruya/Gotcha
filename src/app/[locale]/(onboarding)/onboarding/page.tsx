import { loadResumeState } from '@/features/onboarding/load-onboarding';
import { redirect } from '@/i18n/navigation';
import { resumeStep } from '@/shell/workspace-gate';

/**
 * Onboarding resumes where it really is: no read yet → the website; a read
 * running → reading; read → what it learned, or - with a core system
 * connected - trying it. Every product route sends an admin here.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const step = resumeStep(await loadResumeState());
  redirect({ href: `/onboarding/${step}`, locale });
}
