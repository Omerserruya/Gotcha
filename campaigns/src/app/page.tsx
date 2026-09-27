import { links, C, F } from '@/lib/site';

/*
 * The root of go.gotcha.co.il, which is not a campaign.
 *
 * In production nginx answers `/` with a 302 to the marketing site, so this
 * page is normally never served. It exists anyway, for two reasons: the static
 * export needs a root document for the catch-all fallback to point at, and
 * anyone running this app directly (`npm run dev`, port 3200) lands here.
 *
 * It deliberately says nothing about the product. Every real message on this
 * host belongs to a campaign, and a half-marketing homepage is how a host like
 * this one quietly becomes a second website nobody maintains.
 */
export default function Root() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div>
        <p style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: '.08em', color: C.muted }}>
          GO.GOTCHA.CO.IL
        </p>
        <h1 style={{ fontFamily: F.serif, fontSize: 34, margin: '10px 0 14px', color: C.ink }}>
          Campaign pages live here.
        </h1>
        <p style={{ fontFamily: F.sans, color: C.body, margin: '0 0 24px' }}>
          There is nothing at this address on its own.
        </p>
        <a
          href={links.home()}
          style={{
            fontFamily: F.sans,
            fontWeight: 600,
            color: C.accent,
            borderBottom: `1px solid ${C.accent}`,
            paddingBottom: 2,
          }}
        >
          Go to gotcha.co.il
        </a>
      </div>
    </main>
  );
}
