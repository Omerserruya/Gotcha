// Social profiles are deployment configuration, not code.
//
// A staging site, a regional site and production point at different accounts,
// and an account that does not exist yet should simply not render an icon
// rather than ship a dead link. So each profile is an environment variable and
// an unset value means "no icon".

export type SocialKey = "instagram" | "facebook" | "whatsapp";

export interface SocialLink {
  key: SocialKey;
  href: string;
}

/**
 * Only http(s) survives.
 *
 * The value arrives from deployment config and lands in an `<a href>`. A
 * mistyped `javascript:` or `data:` URL there is a scripting sink, so anything
 * that is not a well formed http(s) URL is treated as "not configured".
 */
export function safeExternalUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Configured social profiles, in display order.
 *
 * The env vars are read by literal member access because that is the only form
 * Next inlines at build time. Reading them through a computed key would leave
 * `undefined` in the static export.
 */
export function getSocialLinks(): SocialLink[] {
  const configured: Array<[SocialKey, string | undefined]> = [
    ["instagram", process.env.NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL],
    ["facebook", process.env.NEXT_PUBLIC_SOCIAL_FACEBOOK_URL],
    ["whatsapp", process.env.NEXT_PUBLIC_SOCIAL_WHATSAPP_URL],
  ];

  return configured
    .map(([key, value]) => ({ key, href: safeExternalUrl(value) }))
    .filter((link): link is SocialLink => link.href !== null);
}
