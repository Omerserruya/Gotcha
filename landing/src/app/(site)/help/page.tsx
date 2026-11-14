import type { Metadata } from 'next';
import HelpHub from './HelpHub';

export const metadata: Metadata = {
  title: 'Help Center | GOTCHA',
  description:
    'How to set GOTCHA up, what each setting does, and the playbook for your trade. Written by the people who built it, in Hebrew and English.',
};

export default function Page() {
  return <HelpHub />;
}
