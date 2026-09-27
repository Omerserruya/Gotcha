import type { Metadata } from 'next';
import TrustHub from '../TrustHub';
import { PUBLIC_LEGAL_DOCS } from '@/content/legal-registry.mjs';
import { LEGAL_CONTENT } from '@/generated/legal';
import { TRUST_ORIGIN } from '@/lib/seo';

/** The Hebrew Trust Center index, as its own address. */
export const metadata: Metadata = {
  title: 'מרכז האמון | GOTCHA',
  description:
    'ההסכמים שחלים על השימוש ב-GOTCHA והדרך שבה אנחנו מטפלים במידע אישי: תנאים, פרטיות, עוגיות, ה-DPA וספקי המשנה שלנו.',
  alternates: {
    canonical: `${TRUST_ORIGIN}/he`,
    languages: { en: TRUST_ORIGIN, he: `${TRUST_ORIGIN}/he`, 'x-default': TRUST_ORIGIN },
  },
};

export default function Page() {
  const cards = PUBLIC_LEGAL_DOCS.map((d: any) => {
    const doc = (LEGAL_CONTENT as any)[d.slug];
    return {
      slug: d.slug,
      icon: d.icon,
      summary: d.summary,
      title: [doc.en.title, doc.he.title] as [string, string],
      effectiveDate: [doc.en.effectiveDate, doc.he.effectiveDate] as [string, string],
    };
  });
  return <TrustHub cards={cards} pinned="he" />;
}
