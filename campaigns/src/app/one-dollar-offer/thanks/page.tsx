import type { Metadata } from 'next';
import ThankYou from '@/components/ThankYou';
import MetaPixel from '@/components/MetaPixel';
import '../../thanks.css';

/*
 * The page you reach by actually submitting the form.
 *
 * It is a route rather than a state flag inside the campaign, which buys three
 * things: an address to link back to, a reload that does not re-submit
 * anything, and one URL that is only ever reached by someone who converted -
 * which is what makes it usable in an ad platform as a destination to measure.
 *
 * NOINDEX, like every page on this host (the root layout sets it). A thank-you
 * page in a search result is a page reached by someone who never filled the
 * form in, which makes the number it is supposed to measure a lie.
 */
export const metadata: Metadata = {
  title: 'תודה | GOTCHA',
  description: 'הפרטים התקבלו. נחזור אליכם לתיאום הדגמה אישית.',
};

export default function Thanks() {
  return (
    <>
      {/*
        The pixel rides the same shared consent record, so this page tracks its
        own view for anyone who allowed measurement. The `Lead` conversion is
        NOT fired here - the campaign fires it before navigating, and firing it
        again on a page a visitor can refresh would count one lead many times.
      */}
      <MetaPixel />
      <ThankYou />
    </>
  );
}
