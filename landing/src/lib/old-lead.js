/**
 * The older design's lead cards, sent where the v8 home's form goes.
 *
 * tools/dc2jsx.mjs grafts the v8 design's alert line and sent card into each of
 * the design's 12 lead cards and binds them to `leadPort.c<n>`; this fills
 * those bindings. A card's state is keyed by page and card, because the same
 * card is drawn on many pages and the landing switches pages without a reload.
 *
 * The copy is the v8 contact form's own, in both languages. The older design
 * translates by dictionary after render, which has none of these strings, so
 * they are handed over already in the page's language.
 * tools/test/old-lead.test.mjs holds it equal to the v8 source.
 */
import { leadFromForm, sendLead, SEND_FAILED } from './home-lead.mjs';
import { PATH_BY_PAGE } from './pages';

export const LEAD_CARDS = 12;

export const LEAD_COPY = {
  en: {
    fields: 'Please fill in your name, phone and website',
    okTitle: 'Got it, thank you',
    okBody: "We'll get back to you today or tomorrow. Want to pick a time right now?",
    pick: 'Pick a time',
  },
  he: {
    fields: 'צריך למלא שם, טלפון וכתובת אתר',
    okTitle: 'קיבלנו, תודה',
    okBody: 'נחזור אליכם היום או מחר. רוצים לקבוע זמן כבר עכשיו?',
    pick: 'בחרו זמן',
  },
};

/** landing-<path>: landing-contact, landing-offer, landing-product-copilot. */
export function sourceFor(page) {
  const p = PATH_BY_PAGE[page];
  if (p === undefined) return `landing-${page}`;
  return `landing-${p.replace(/^\//, '').replace(/\//g, '-') || 'home'}`;
}

async function submit(comp, ev, id, page) {
  const card = ev.currentTarget && ev.currentTarget.closest('[data-lead-card]');
  if (!card) return;
  comp.__leadBusy = comp.__leadBusy || {};
  if (comp.__leadBusy[id]) return;
  // By name; the offer page's data-drawn card has unnamed inputs in this
  // order, which tools/dc2jsx.mjs asserts.
  const ORDER = ['name', 'phone', 'site', 'mail'];
  const v = (n) => {
    const i = card.querySelector(`input[name="${n}"]`) || card.querySelectorAll('input')[ORDER.indexOf(n)];
    return i ? i.value : '';
  };
  const set = (patch) =>
    comp.setState((prev) => {
      const all = prev.leads || {};
      return { leads: { ...all, [id]: { ...(all[id] || {}), ...patch } } };
    });
  const lead = leadFromForm({ name: v('name'), phone: v('phone'), site: v('site'), mail: v('mail') }, sourceFor(page));
  if (!lead) {
    set({ err: 'fields' });
    return;
  }
  comp.__leadBusy[id] = true;
  set({ err: null });
  const result = await sendLead(lead);
  comp.__leadBusy[id] = false;
  set(result === 'sent' ? { sent: true, err: null } : { err: 'send' });
}

/** The bindings for every card, for the page the landing is showing now. */
export function leadPort(comp) {
  const st = comp.state || {};
  const page = st.page;
  const lang = st.lang === 'he' ? 'he' : 'en';
  const copy = LEAD_COPY[lang];
  const leads = st.leads || {};
  const out = {};
  for (let n = 0; n < LEAD_CARDS; n++) {
    const id = `${page}:${n}`;
    const s = leads[id] || {};
    const go = (ev) => submit(comp, ev, id, page);
    out[`c${n}`] = {
      notSent: !s.sent,
      sent: !!s.sent,
      err: !!s.err,
      errText: s.err === 'send' ? SEND_FAILED[lang] : copy.fields,
      okTitle: copy.okTitle,
      okBody: copy.okBody,
      pick: copy.pick,
      submit: go,
      // A <div role="button"> answers Enter and Space the way a button would.
      key: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          go(ev);
        }
      },
    };
  }
  return out;
}
