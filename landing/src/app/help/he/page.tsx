import type { Metadata } from 'next';
import HelpHub from '../HelpHub';
import { HELP_ORIGIN } from '@/lib/seo';

/** The Hebrew Help Center index, as its own address. */
export const metadata: Metadata = {
  title: 'מרכז העזרה | GOTCHA',
  description:
    'איך מגדירים את GOTCHA, מה כל הגדרה עושה, והמדריך לתחום שלכם. נכתב על ידי מי שבנה את זה.',
  alternates: {
    canonical: `${HELP_ORIGIN}/he`,
    languages: { en: HELP_ORIGIN, he: `${HELP_ORIGIN}/he`, 'x-default': HELP_ORIGIN },
  },
};

export default function Page() {
  return <HelpHub pinned="he" />;
}
