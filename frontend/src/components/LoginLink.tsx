"use client";

import { useEffect, useState } from "react";
import { loginUrl } from "@/lib/marketing-origin";

/**
 * A "Log in" link that survives the two-hostname split.
 *
 * Deliberately NOT a Next `<Link>`. On the marketing host a `<Link href="/login">`
 * was serviced client-side: the URL became gotcha.co.il/login without a request
 * ever reaching nginx, so the `return 301 https://app.gotcha.co.il` that exists
 * for exactly this case never ran, and the visitor was stranded on an origin
 * where sign-in cannot work (Authentik grants OIDC CORS only to the application
 * origin). A plain anchor is a real navigation, which is what makes the host
 * hop happen at all.
 *
 * The href resolves in two steps because this is a static export: the prerendered
 * HTML has no `window`, so it ships the relative `/login` - already correct, and
 * on the marketing host nginx redirects it. After hydration the effect upgrades
 * it to the absolute application URL, so the browser goes straight there and
 * skips the redirect hop entirely.
 */
export default function LoginLink({
  className,
  onClick,
  children,
  next,
}: {
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
  next?: string;
}) {
  const [href, setHref] = useState(next ? `/login?next=${encodeURIComponent(next)}` : "/login");

  useEffect(() => {
    setHref(loginUrl(window.location.origin, next));
  }, [next]);

  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
