import { links, C, F } from '@/lib/site';

/*
 * Exported as 404.html, which nginx serves via `error_page 404`.
 *
 * Worth having rather than letting nginx render its own: a mistyped or expired
 * campaign URL is usually PAID traffic - somebody clicked an ad - and the
 * default nginx 404 page throws that click away. This one at least points at
 * the marketing site.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
        fontFamily: F.sans,
      }}
    >
      <div>
        <h1 style={{ fontFamily: F.serif, fontSize: 34, margin: '0 0 12px', color: C.ink }}>
          This page is no longer here.
        </h1>
        <p style={{ color: C.body, margin: '0 0 24px' }}>
          Campaign pages come down when the campaign ends.
        </p>
        <a
          href={links.home()}
          style={{
            display: 'inline-block',
            background: C.accent,
            color: '#fff',
            fontWeight: 600,
            padding: '13px 24px',
            borderRadius: 12,
          }}
        >
          Go to gotcha.co.il
        </a>
      </div>
    </main>
  );
}
