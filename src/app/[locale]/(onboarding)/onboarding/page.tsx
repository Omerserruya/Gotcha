import { redirect } from '@/i18n/navigation';

/** Onboarding starts at its first step. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: '/onboarding/website', locale });
}
