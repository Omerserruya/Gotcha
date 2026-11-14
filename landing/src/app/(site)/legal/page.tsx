import type { Metadata } from 'next';
import TrustHub from './TrustHub';
import { PUBLIC_LEGAL_DOCS } from '@/content/legal-registry.mjs';
import { LEGAL_CONTENT } from '@/generated/legal';

export const metadata: Metadata = {
  title: 'Trust Center | GOTCHA',
  description:
    'The agreements that govern your use of GOTCHA and the way we handle personal data: terms, privacy, cookies, our DPA and the subprocessors we use. Published in Hebrew and English.',
};

export default function Page() {
  // Titles and dates come from the documents themselves; only the summaries and
  // the ordering are editorial, and those live in the registry.
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

  return <TrustHub cards={cards} />;
}
