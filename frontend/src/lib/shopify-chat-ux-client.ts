/**
 * Shopify chat settings - the few rules the FORM needs to know locally.
 *
 * The frontend deliberately does not import `@chatcenter/shared`. It is not
 * an npm workspace, has its own dependency tree, and the dev container
 * mounts only `./frontend`, so the package is not resolvable at runtime.
 * A production build can find it by walking up to the root `node_modules`
 * and the dev server cannot - which is a build that passes CI and a
 * settings page that is broken for whoever is actually working on it.
 *
 * The server stays authoritative. Every channel read and write goes
 * through `normalizeShopifyLiveChatConfig`, so what the form loads is
 * already canonical and needs no normalizer here. What IS worth having
 * locally is immediate feedback: telling a merchant that a URL will be
 * refused at the moment they paste it, rather than after a save and a
 * puzzled look at their live storefront.
 *
 * These mirror `packages/shared/src/lib/shopify-chat-ux.ts` and are pinned
 * to it by `__tests__/shopify-chat-ux-parity.test.ts`, which imports both
 * and fails if they ever disagree.
 */

export const HERO_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"];
export const HERO_VIDEO_EXTENSIONS = [".mp4", ".webm"];

export const MEDIA_GUIDANCE = {
  imageMaxBytes: 1_500_000,
  videoMaxBytes: 5_000_000,
  videoMaxSeconds: 12,
  recommendedWidth: 784,
  recommendedHeight: 420,
} as const;

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * The same rule the storefront applies, so the form can refuse a URL the
 * widget would silently drop.
 */
export function sanitizeMediaUrl(raw: unknown, kind: "image" | "video" = "image"): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!HOST_RE.test(u.hostname)) return null;

  const pathname = u.pathname.toLowerCase();
  if (pathname.endsWith(".svg") || pathname.endsWith(".svgz")) return null;

  // An extension is a hint, not proof: CDNs serve media from extensionless
  // paths all the time. Only a positively wrong extension is refused.
  const known = [...HERO_IMAGE_EXTENSIONS, ...HERO_VIDEO_EXTENSIONS];
  const ext = known.find((e) => pathname.endsWith(e));
  if (ext) {
    const allowed = kind === "video" ? HERO_VIDEO_EXTENSIONS : HERO_IMAGE_EXTENSIONS;
    if (!allowed.includes(ext)) return null;
  }
  return u.toString().slice(0, 1024);
}

/**
 * How tall the hero will actually be, given the panel it has to share.
 *
 * The merchant's number is a preference; the panel has the last word. A
 * hero that leaves no room for the title and a couple of questions is not
 * a taller hero, it is a broken welcome screen.
 */
export function resolveHeroHeight(input: {
  configured: number;
  panelHeight: number;
  isMobile: boolean;
}): number {
  const { configured, panelHeight, isMobile } = input;
  const RESERVED = isMobile ? 264 : 288;
  const byPanel = Math.max(0, panelHeight - RESERVED);
  const byFraction = Math.floor(panelHeight * (isMobile ? 0.22 : 0.25));
  const capped = Math.min(configured, byPanel, byFraction);
  return capped < 72 ? 0 : capped;
}

export function heroHeightWarning(input: {
  configured: number;
  panelHeight: number;
  isMobile: boolean;
}): "ok" | "tight" | "dropped" {
  const resolved = resolveHeroHeight(input);
  if (resolved === 0) return "dropped";
  if (resolved < input.configured) return "tight";
  return "ok";
}

/**
 * Defaults for a channel the merchant has not saved yet.
 *
 * Only what the form renders before the first save; the server fills in
 * everything else the moment the channel exists.
 */
export const WELCOME_FALLBACK = {
  title: "How can I help?",
  subtitle: "Ask us anything about our products and we will help you choose.",
  assistantName: "Store Assistant",
  suggestedQuestions: [] as string[],
  avatarUrl: null as string | null,
  avatarSize: 56,
  avatarOverlap: 30,
  showAvatarBorder: true,
  textAlign: "center" as "center" | "start",
};

export const HERO_FALLBACK = {
  mediaType: "none" as "none" | "image" | "gif" | "video",
  mediaUrl: null as string | null,
  posterUrl: null as string | null,
  height: 124,
  mobileHeight: 108,
  focalPoint: "50% 50%",
  objectFit: "cover" as "cover" | "contain",
  overlayStrength: 0,
  fadeStrength: 60,
  cornerRadius: 0,
  backgroundColor: "#ffffff",
  videoLoop: true,
  videoAutoplay: true,
};
