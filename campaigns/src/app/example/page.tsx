import type { Metadata } from 'next';
import { links, C, F } from '@/lib/site';

/*
 * go.gotcha.co.il/example - the deploy canary, and the shape to copy.
 *
 * It does two jobs, and it is worth keeping both in mind before deleting it:
 *
 *  1. It proves the pipeline. After a gateway deploy, this URL answering 200
 *     with this markup proves the whole chain - the campaigns build ran, its
 *     `out/` reached the image, the vhost is mapped, and DNS plus the
 *     cloudflared ingress rule for this hostname exist. When a real campaign
 *     page 404s, this page is the first thing to check, because it separates
 *     "my page is wrong" from "this host is not wired up".
 *
 *  2. It is the template. A new campaign is `cp -r example <name>`, then
 *     rewrite the copy. Nothing below is clever; that is the point.
 *
 * It is noindex like every page here (the root layout sets it), so it costs
 * nothing to leave in place.
 */

export const metadata: Metadata = {
  title: 'Example campaign - GOTCHA',
};

export default function Example() {
  return (
    <main style={{ fontFamily: F.sans, color: C.ink }}>
      <section
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: 'calc(72px + var(--safe-top)) 20px 64px',
        }}
      >
        <p style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: '.08em', color: C.accent }}>
          EXAMPLE CAMPAIGN
        </p>

        <h1
          style={{
            fontFamily: F.serif,
            fontSize: 'clamp(34px, 7vw, 54px)',
            lineHeight: 1.08,
            margin: '14px 0 16px',
          }}
        >
          This page exists to prove the route works.
        </h1>

        <p style={{ fontSize: 17, lineHeight: 1.6, color: C.body, margin: '0 0 28px' }}>
          If you are reading this on go.gotcha.co.il, the campaigns build reached production and
          the hostname is wired end to end. Copy this directory to start a real campaign.
        </p>

        <a
          href={links.app()}
          style={{
            display: 'inline-block',
            background: C.accent,
            color: '#fff',
            fontWeight: 600,
            padding: '14px 26px',
            borderRadius: 12,
          }}
        >
          Primary call to action
        </a>

        <p style={{ fontSize: 13, color: C.muted, margin: '18px 0 0' }}>
          Every link out of this host is absolute, because go.gotcha.co.il has no /login of its
          own. Use <code style={{ fontFamily: F.mono }}>links</code> from{' '}
          <code style={{ fontFamily: F.mono }}>@/lib/site</code> rather than writing the URL.
        </p>
      </section>

      <footer
        style={{
          background: C.footerBg,
          color: C.footerInk,
          padding: `28px 20px calc(28px + var(--safe-bottom))`,
        }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            fontSize: 13,
          }}
        >
          <span style={{ opacity: 0.7 }}>© GOTCHA</span>
          <a href={links.trust('privacy-policy')}>Privacy</a>
          <a href={links.trust('terms-of-service')}>Terms</a>
          <a href={links.home()}>gotcha.co.il</a>
        </div>
      </footer>
    </main>
  );
}
