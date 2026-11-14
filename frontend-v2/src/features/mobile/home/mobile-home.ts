import { TONE_BY_INTENT, type QueueTone } from '@/features/home/queue-row';

/**
 * The pure parts of the phone's Home: which greeting, which dot.
 *
 * Separate from the screen so they can be tested without a Server Component
 * and a translation runtime.
 */

/**
 * The greeting's key under `home.greeting`, as the website's Home picks it.
 *
 * From the hour the page was rendered: "good morning" at 9pm is worse than no
 * greeting. Quiet (nothing waiting) has its own words, and a name has its own
 * branch, because "Good morning, " with nobody after it is a sentence cut off.
 */
export function greetingKey(hour: number, quiet: boolean, named: boolean): string {
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return [named ? 'named' : null, quiet ? 'quiet' : null, part].filter(Boolean).join('.');
}

/**
 * A queue row's dot, from the intent the ranker weighed.
 *
 * The website's map, not a second one: a row that is red on the desktop is
 * red here. An unrecognised intent is the neutral dot, never a guess.
 */
export function rowTone(intent: string): QueueTone | 'neutral' {
  return Object.hasOwn(TONE_BY_INTENT, intent) ? (TONE_BY_INTENT[intent] ?? 'neutral') : 'neutral';
}
