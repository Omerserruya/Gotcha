# Campaign landing pages - `go.gotcha.co.il`

Static Next.js pages for paid campaigns. A third, independent app beside
`frontend/` (the product) and `landing/` (the marketing site).

## Why it is separate

A campaign page is written for one ad flight, is replaced often, and is deleted
when the flight ends. Keeping those pages out of `landing/` means:

- a campaign ships without rebuilding or redeploying the marketing site
- a mistake in a campaign page cannot take `gotcha.co.il` down
- campaign copy never competes with the marketing site in search (see below)
- the marketing site's design pipeline (`landing/design/*.dc.html` →
  `npm run design:sync`) stays untouched; campaign pages are written by hand

The cost is that shared elements are duplicated rather than imported. That is
deliberate. A campaign that needs the full marketing chrome is a page for
`gotcha.co.il`, not a campaign page.

## Adding a campaign

```bash
cd campaigns
cp -r src/app/example src/app/<campaign-name>
# rewrite the copy, set `metadata.title`
npm run dev          # http://localhost:3200/<campaign-name>
```

The URL is the directory name: `src/app/spring-promo/page.tsx` is served at
`https://go.gotcha.co.il/spring-promo`.

### Rules worth knowing before you write one

**Every outbound link must be absolute.** `go.gotcha.co.il` has no `/login`,
no `/pricing` and no `/legal` of its own - a relative link is answered by this
host's own catch-all and 404s. Use `links` from `@/lib/site`, which defaults to
the production hostnames, rather than typing a URL.

**Pages are `noindex`.** The root layout sets it and `public/robots.txt` repeats
it, and the two are not redundant: `robots.txt` asks a crawler not to fetch, the
meta tag asks it not to index, and a page linked from elsewhere can be indexed
without ever being fetched. A page that wants organic traffic belongs on
`gotcha.co.il`.

**Trailing slashes are on.** `trailingSlash: true` (the opposite of `landing/`)
emits `<campaign>/index.html`, so `/spring-promo` and `/spring-promo/` both
resolve. Ad platforms rewrite URLs, and neither form may 404.

**An unknown path returns a real 404**, not a fallback document. This differs
from the app vhost, where anything unmatched falls through to `index.html` with
a 200. Separate documents, separate answers - a mistyped campaign URL that
silently rendered some other campaign's page would look like a working link in
the ad platform's stats.

## Deployment

The static export is copied into the gateway image, the same way the other two
trees are:

| Tree | Image path | Hostnames |
|------|-----------|-----------|
| `frontend/out` | `/usr/share/nginx/html` | `app.gotcha.co.il` |
| `landing/out` | `/usr/share/nginx/landing` | `gotcha.co.il`, `www.`, `help.`, `trust.` |
| `campaigns/out` | `/usr/share/nginx/campaigns` | `go.gotcha.co.il` |

`scripts/docker-publish.sh` builds all three on the host (cross-arch buildx
cannot reach Google Fonts under QEMU, so the Node build never runs inside the
image) and `gateway/Dockerfile.prod` copies them in. `SKIP_CAMPAIGNS_BUILD=1`
reuses an existing `campaigns/out`, matching the frontend and landing flags.

Publishing a campaign therefore means rebuilding and deploying the **gateway**,
which also carries the app bundle and the marketing site. Check what is sitting
in `frontend/out` and `landing/out` before you publish - a stale tree from
another branch ships with your campaign.

### This hostname needs DNS and a cloudflared ingress rule

Neither is in this repo, and **both** are required. `go.gotcha.co.il` needs:

1. a DNS route for the name, and
2. an ingress rule in the cloudflared config pointing it at the gateway

With the nginx vhost but no ingress rule, the name does not resolve and nginx
never sees the request - there is no partial state where it half works.

### Verifying a deploy

`https://go.gotcha.co.il/example` is the canary. It answering 200 proves the
build ran, `out/` reached the image, the vhost is mapped, and DNS plus the
ingress rule exist. Check it before debugging an individual campaign page.

Verify by **content**, never by timestamp - grep the served HTML for a string
you just wrote. An interrupted build leaves a previous `out/` in place, and it
looks fresh.
