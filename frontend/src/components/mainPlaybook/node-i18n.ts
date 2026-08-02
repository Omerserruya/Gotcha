// Node/category localization (§5). The node `type` is the STABLE canonical
// identity (send_message_text, voice_add_participant, …); the displayed label
// is rendered through i18n keys `aiStudio.nodes.<type>.label|desc` with a
// graceful fallback to the registry's English `label`/`summary` so a
// not-yet-translated node still shows something sensible. Categories localize
// through `aiStudio.nodeCategories.<slug>`.
import { NODE_REGISTRY } from "./node-registry";

type T = (key: string) => string;

function resolved(t: T, key: string): string | null {
  const v = t(key);
  return v && v !== key ? v : null;
}

/**
 * Localized node label. Falls back to an explicit English `fallback` (e.g. a
 * palette item's own label for legacy types not in the registry), then the
 * registry label, then the raw type.
 */
export function nodeLabel(type: string | undefined, t: T, fallback?: string): string {
  if (!type) return fallback ?? "";
  return resolved(t, `aiStudio.nodes.${type}.label`) ?? fallback ?? NODE_REGISTRY[type]?.label ?? type;
}

/** Localized one-line node description; falls back to an explicit English one. */
export function nodeDesc(type: string | undefined, t: T, fallback?: string): string {
  if (!type) return fallback ?? "";
  return resolved(t, `aiStudio.nodes.${type}.desc`) ?? fallback ?? "";
}

function categorySlug(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Localized category label (Triggers, Messages, …), falling back to English. */
export function nodeCategoryLabel(category: string | undefined, t: T): string {
  if (!category) return "";
  return resolved(t, `aiStudio.nodeCategories.${categorySlug(category)}`) ?? category;
}

/** Localized process-template name, falling back to the template's English name. */
export function templateName(id: string, t: T, fallback: string): string {
  return resolved(t, `aiStudio.templates.${id}.name`) ?? fallback;
}

/** Localized process-template description, falling back to English. */
export function templateDesc(id: string, t: T, fallback: string): string {
  return resolved(t, `aiStudio.templates.${id}.desc`) ?? fallback;
}
