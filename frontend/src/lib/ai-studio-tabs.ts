// AI Studio tab contract - the SINGLE source of truth for tab identity and
// navigation. The URL (`?tab=`) is authoritative; no component stores its own
// copy of the selected tab. Nested pages (flows/agents/knowledge/marketplace)
// import `aiStudioHref` so Back always returns to the exact origin tab instead
// of falling through to a default.
//
// Canonical tabs (AI Employees is the default - Team is intentionally NOT a
// canonical key, so it can never be an accidental default from route parsing):
//   employees  - the AI employee roster + status/readiness/persona summary.
//                Named for what it holds. It was called "overview", which said
//                nothing about the content and left the roster looking like a
//                dashboard rather than the list of people you hired.
//   knowledge  - mapped knowledge sources + ingestion
//   processes  - workflow/process design (React Flow canvas)
//   tools      - executable integrations + system tools + integration HITL

export const AI_STUDIO_TABS = ["employees", "knowledge", "processes", "tools"] as const;
export type AiStudioTab = (typeof AI_STUDIO_TABS)[number];

export const DEFAULT_AI_STUDIO_TAB: AiStudioTab = "employees";

// Legacy → canonical. Old bookmarks, the Settings legacy redirects
// (`/settings/tools → ?tab=skills`), guided-tour anchors and any external link
// still resolve. `team` maps to employees so a stale `?tab=team` link lands on
// AI Employees, never re-introducing Team as a default.
const TAB_ALIASES: Record<string, AiStudioTab> = {
  team: "employees",
  // Every ?tab=overview link ever shared - bookmarks, guided-tour anchors,
  // in-product links, docs - keeps working and lands on AI Employees.
  overview: "employees",
  employees: "employees",
  knowledge: "knowledge",
  playbooks: "processes",
  processes: "processes",
  skills: "tools",
  tools: "tools",
};

export function isAiStudioTab(value: string | null | undefined): value is AiStudioTab {
  return value != null && (AI_STUDIO_TABS as readonly string[]).includes(value);
}

/**
 * Resolve any `?tab=` value (canonical or legacy alias) to a canonical tab.
 * Missing/invalid/junk → the AI Employees default. NEVER returns team.
 */
export function normalizeAiStudioTab(value: string | null | undefined): AiStudioTab {
  if (value == null) return DEFAULT_AI_STUDIO_TAB;
  return TAB_ALIASES[value] ?? DEFAULT_AI_STUDIO_TAB;
}

/** Canonical AI Studio URL for a tab, preserving optional extra params. */
export function aiStudioHref(tab: AiStudioTab, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ tab, ...(extra ?? {}) });
  return `/ai-studio?${params.toString()}`;
}

// i18n key for a tab label (aiStudio.tabs.<key>).
export function aiStudioTabI18nKey(tab: AiStudioTab): string {
  return `aiStudio.tabs.${tab}`;
}
