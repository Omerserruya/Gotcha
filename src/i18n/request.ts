import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_LOCALE, isLocale } from './locales';
import { loadMessages } from './load-messages';

/**
 * Per-request i18n configuration.
 *
 * Formats are declared centrally so that a date rendered in the Inbox and the
 * same date in Analytics are identical, and so that changing how the product
 * writes dates is one edit rather than a search across every component.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: 'Asia/Jerusalem',
    formats: {
      dateTime: {
        /*
         * The greeting's date: weekday, day and month, no year.
         *
         * Ordering is left to the locale rather than forced to the mockup's.
         * English puts the weekday first and Hebrew says "יום שבת, 6 בספטמבר";
         * hard-coding the Latin order would produce something no Hebrew reader
         * writes.
         */
        greeting: { weekday: 'long', day: 'numeric', month: 'long' },
        short: { day: 'numeric', month: 'short' },
        medium: { day: 'numeric', month: 'short', year: 'numeric' },
        time: { hour: '2-digit', minute: '2-digit' },
        timestamp: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
      },
      number: {
        integer: { maximumFractionDigits: 0 },
        percent: { style: 'percent', maximumFractionDigits: 1 },
        compact: { notation: 'compact', maximumFractionDigits: 1 },
      },
    },
    // A missing translation must never render a raw key to a customer. In
    // development it is loud; in production it falls back silently to English.
    onError(error) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] ${error.message}`);
      }
    },
    getMessageFallback({ namespace, key }) {
      return process.env.NODE_ENV === 'production' ? '' : `⟪${namespace}.${key}⟫`;
    },
  };
});
