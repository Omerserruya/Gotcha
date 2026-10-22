import { SAAS_DEFAULT_FUNNEL, SERVICE_DEFAULT_FUNNEL, type FunnelConfig } from "../services/funnel-config.service";

/**
 * Ready-made sales funnels a hire can start from (2026-10-13), so a Sales
 * employee can be hired without designing stages by hand. Each template is
 * one of the canonical funnels the stage engine is tested against; only the
 * names and stage labels are translated.
 */
export type TemplateLanguage = "he" | "en";

interface Template {
  config: FunnelConfig;
  name: Record<TemplateLanguage, string>;
  description: Record<TemplateLanguage, string>;
  /** Stage id -> label per language. English is the config's own label. */
  labels: Record<TemplateLanguage, Record<string, string>>;
}

const labelsOf = (c: FunnelConfig) => Object.fromEntries(c.stages.map((s) => [s.id, s.label]));

export const FUNNEL_TEMPLATES: Record<string, Template> = {
  "saas-default": {
    config: SAAS_DEFAULT_FUNNEL,
    name: { he: "מכירת תוכנה ומוצרים דיגיטליים", en: "Software and digital products" },
    description: {
      he: "מליד חדש, דרך הדגמה, עד סגירה",
      en: "From a new lead, through a demo, to closing",
    },
    labels: {
      en: labelsOf(SAAS_DEFAULT_FUNNEL),
      he: { lead: "ליד חדש", demo: "נקבעה הדגמה", qualified: "מתאים", objection: "התנגדות", closing: "סגירה" },
    },
  },
  "service-default": {
    config: SERVICE_DEFAULT_FUNNEL,
    name: { he: "שירותים והצעות מחיר", en: "Services and quotes" },
    description: {
      he: "מפנייה, דרך הצעת מחיר, עד קביעת שירות",
      en: "From an inquiry, through a quote, to a booking",
    },
    labels: {
      en: labelsOf(SERVICE_DEFAULT_FUNNEL),
      he: { inquiry: "פנייה", quoted: "נשלחה הצעת מחיר", scoped: "הוגדר צורך", objection: "התנגדות", booked: "נקבע" },
    },
  },
};

export function templateLanguage(locale: string | null | undefined): TemplateLanguage {
  return String(locale ?? "").toLowerCase().startsWith("he") ? "he" : "en";
}

/** The list a reader sees: id, name, description and stage labels in their language. */
export function listFunnelTemplates(lang: TemplateLanguage) {
  return Object.entries(FUNNEL_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name[lang],
    description: t.description[lang],
    stages: t.config.stages.map((s) => ({ id: s.id, label: t.labels[lang][s.id] ?? s.label })),
  }));
}

/** The stages, transitions and overrides to store, with labels in the workspace's language. */
export function funnelFromTemplate(id: string, lang: TemplateLanguage) {
  const t = FUNNEL_TEMPLATES[id];
  if (!t) return null;
  const c = t.config;
  return {
    funnelId: c.funnelId,
    stages: c.stages.map((s) => ({ ...s, label: t.labels[lang][s.id] ?? s.label })),
    transitions: c.transitions ?? [],
    strategyOverrides: c.strategyOverrides ?? null,
    playbookOverrides: c.playbookOverrides ?? null,
  };
}
