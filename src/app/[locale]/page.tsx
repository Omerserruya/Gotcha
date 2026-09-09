import { redirect } from '@/i18n/navigation';

/**
 * The application root sends people to Home. Locale-aware redirect, so
 * `/he` lands on `/he/home` rather than dropping the language.
 */
export default async function RootPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: '/home', locale });
}
