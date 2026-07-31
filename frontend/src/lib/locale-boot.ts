import { localeConfig, type Locale, type Direction } from "@/i18n";

/**
 * Getting `lang` and `dir` right before the first paint.
 *
 * The root layout renders `<html lang="en" dir="ltr">` and a post-hydration
 * effect corrects it. That is deliberate: reading the locale during render
 * would remount the tree, and a remount unmounts VoiceCallContext and destroys
 * the Twilio Device mid-call.
 *
 * The cost lands on the Hebrew launch market - every full page load flashed
 * left-to-right until React hydrated, and a first-time visitor got English
 * regardless of what their browser asked for.
 *
 * Two ways to fix it, and the obvious one is wrong here:
 *
 *   Server-side, via a cookie. Correct `lang` in the served HTML, which
 *   crawlers and screen readers see without running JS - but `cookies()` in a
 *   root layout makes EVERY page dynamic, and this app statically generates
 *   its public pages (`legal/[slug]` sets `dynamicParams = false`). It would
 *   also buy nothing for those pages: each legal document ships both languages
 *   behind a toggle, so no single server-rendered `lang` is right for them.
 *
 *   A tiny script in <head>, which is what this is. It runs before the first
 *   paint, so there is no flash, and it leaves static generation alone. What
 *   it cannot fix is the `lang` attribute in the served HTML for a client that
 *   never runs JS - accepted, because the alternative costs static rendering
 *   across the whole site to fix one attribute on pages that are bilingual
 *   anyway.
 */

const LOCALE_COOKIE = "locale";

function isLocale(v: unknown): v is Locale {
  return v === "en" || v === "he";
}

/**
 * The locale to boot with: an explicit choice, else the browser's preference,
 * else English.
 *
 * `languages` takes the tags in the order given. Browsers already send their
 * own preference order, and mis-ranking someone's language is worse than
 * ignoring a q-weight.
 */
export function pickLocale(cookieValue: string | null | undefined, languages: readonly string[]): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  for (const tag of languages) {
    const base = String(tag || "").trim().toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return "en";
}

export function directionFor(locale: Locale): Direction {
  return localeConfig[locale].dir;
}

/**
 * The inline script. Kept deliberately tiny and dependency-free: it runs before
 * anything else on the page, so it must not be able to throw.
 *
 * It mirrors `pickLocale` - the two are checked against each other in
 * `__tests__/locale-boot.test.ts`, because a script that drifts from the
 * function it is supposed to mirror would set a direction the app then
 * disagrees with.
 */
export const LOCALE_BOOT_SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)/);
var l=m&&m[1];
if(l!=='en'&&l!=='he'){
  var n=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'']);
  l='en';
  for(var i=0;i<n.length;i++){var b=String(n[i]||'').toLowerCase().split('-')[0];if(b==='en'||b==='he'){l=b;break;}}
}
document.documentElement.lang=l;
document.documentElement.dir=(l==='he'?'rtl':'ltr');
}catch(e){}})();`;

export { LOCALE_COOKIE };
