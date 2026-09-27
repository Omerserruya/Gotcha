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
  `npm run design:sync`) stays untouched; this app has its own compilers for
  its own design files, and neither can break the other

The cost is that shared elements are duplicated rather than imported. That is
deliberate. A campaign that needs the full marketing chrome is a page for
`gotcha.co.il`, not a campaign page.

## The campaigns

| URL | Source | What it is |
|-----|--------|------------|
| `/one-dollar-offer` | `design/GOTCHA Campaign Landing.dc.html` | The Hebrew demo-booking campaign, compiled from the design file |
| `/example` | `src/app/example/page.tsx` | The deploy canary and the hand-written template |

## Adding a campaign

There are two ways in, and which one you use depends on where the page came
from.

**From a design file** (what `/one-dollar-offer` is). Put the `.dc.html` in `design/`, point
`tools/dc2jsx.mjs` and `tools/build-logic.mjs` at it, and run:

```bash
npm run design:sync    # design file -> src/generated/ + src/components/
npm run dev            # http://localhost:3200/one-dollar-offer
```

The generated output is committed, so `next build` never runs the compilers -
only a person re-syncing a changed design does. **Edits belong in the design
file, not in the generated files**, which are overwritten on the next sync.

**Written by hand** (what `/example` is):

```bash
cp -r src/app/example src/app/<campaign-name>
```

Either way the URL is the directory name: `src/app/spring-promo/page.tsx` is
served at `https://go.gotcha.co.il/spring-promo`.

### The design compilers

`tools/dc2jsx.mjs` turns the design's `<x-dc>` markup into `Template.jsx` and
its `<helmet>` CSS into `src/app/campaign.css`. `tools/build-logic.mjs` turns
its `DCLogic` class into a React component. Both are mechanical: re-running
them reproduces the port, so the page stays a clone of the design rather than a
transcription of it.

They are close cousins of `landing/tools/*` and deliberately not shared with
them - see the header of `tools/dc2jsx.mjs` for why. Two things to know:

- They need `parse5`, which this repo has only as a transitive dependency of
  `frontend/`. The resolver looks in several places, including the main
  checkout when you are running from a git worktree. It is a dev-time need
  only.
- **Every patch `build-logic.mjs` applies to the design's source is asserted.**
  If the design renames a config field or rewrites its submit handler, the sync
  fails loudly instead of shipping a page whose form posts nowhere.

### What the design left for us to fill in, and what was filled

The design file ships its integration points as `null`, with a comment saying
they are set before publication. `build-logic.mjs` sets them:

| Field | Value | Why |
|-------|-------|-----|
| `leadEndpoint` | `/api/waitlist` | Same-origin, proxied to the auth service by this host's vhost. No CORS involved. |
| `privacyUrl`, `termsUrl` | Trust Center | Both documents are published. |
| `metaPixelId` | GOTCHA's pixel, `NEXT_PUBLIC_META_PIXEL_ID` to override | The same pixel the marketing site loads. Hard-coded rather than left to the environment, because "someone remembers to set a build variable" is not a mechanism and a campaign without it silently cannot report its conversions. Still gated on consent. |
| `offerTermsUrl`, `accessibilityUrl`, `cookiesUrl` | **still null** | These documents do not exist. The design already renders a marked non-link for a missing document, which is better than a link that goes nowhere. |

The form's four fields are mapped onto the lead endpoint's names
(`name`→`firstName`, `site`→`companyDomain`), and the leads are tagged
`source: 'campaign-one-dollar-offer'`. That source matters: `early-access-form` puts the
endpoint into a stricter mode that rejects any lead without an email address,
and this form asks for email optionally.

A duplicate (HTTP 409 - the phone or email is already on the list) is treated as
success rather than as an error, because from the visitor's side it is. The
`lead` conversion event is deliberately not fired a second time.

## Measurement, and the consent it depends on

The lead reports to Meta as the **standard `Lead` event**, not a custom one. A
custom event shows up in Events Manager immediately but is not selectable as an
optimisation goal until somebody builds a Custom Conversion on it by hand, so a
lead campaign pointed at the standard event would wait for a conversion that
never arrives. Only `lead` is remapped; `demo_click_hero` and the rest stay
custom, which is what they are.

**Nothing is sent until the visitor allows advertising measurement.** The Cookie
Policy says, in both languages, that "the pixel is not loaded at all until you
turn it on: refusing means the script is never requested, not that it is loaded
and told to stay quiet". `MetaPixel` honours that: with no consent, or with no
`NEXT_PUBLIC_META_PIXEL_ID` at build time, it renders nothing and requests
nothing.

The consent record is the `gotcha_consent` cookie, set on `.gotcha.co.il` and
therefore **shared with the marketing site**. Someone who already answered on
gotcha.co.il is never shown the card here and their pixel loads on arrival.
Campaign traffic arrives cold, though, so `CookieNotice` exists on this host
too - without it those visitors would never be asked, the pixel would never
load, and the campaign could not report its own conversions.

`src/lib/consent.ts` is a **copy** of the marketing site's. The two apps share
one cookie, so `CONSENT_VERSION`, the cookie name and the record's shape are a
wire format between two applications rather than an implementation detail of
either. **Change them in landing/ and change them here in the same commit**, or
each will treat the other's record as stale and re-ask.

### How this was verified

In a real browser, against the built export served through the actual vhost,
with Meta's `fbevents.js` replaced by a recorder that writes every `fbq()` call
into the DOM. The browser runs in a container - the host's cached Chromium
cannot be driven here, and the Playwright module is not installed.

| Visitor | Card | Meta's script | Calls made |
|---|---|---|---|
| No consent record | shown | not requested | none |
| Allowed | hidden | loaded | `init <id>`, `track PageView` |
| Refused | hidden | not requested | none |

And the whole conversion path, by filling and submitting the form inside a
same-origin frame, against each answer the endpoint can give:

| Endpoint | Thank-you shown | `Lead` fired |
|---|---|---|
| 201, a new lead | yes | **yes** |
| 409, already on the list | yes | **no** - no second conversion |
| 500, a real failure | no, the error is shown | no |

The full call sequence on a successful submit is
`init <id> | track PageView | trackCustom form_start | trackCustom
demo_form_submit_attempt | track Lead` - the standard `Lead` among customs,
which is the whole point of the remap.

**Still not verified, and it cannot be from here:** that Meta's own script then
delivers those events to Meta. `09e679f9` recorded the same limit for the same
integration. Confirm in Events Manager once a real visitor has been through.

## Images

Campaign pages are opened from a paid click, usually on a phone, usually on
mobile data. Weight is a conversion problem, not a nicety.

The assets in `public/assets/` are the marketing site's, downscaled to roughly
three times the size this page actually renders them at, and `founder-1` is a
photograph so it is a JPEG rather than a PNG. Together that took `/one-dollar-offer` from
3276 KB to 965 KB (~610 KB over the wire). Next preloads every one of these
images in `<head>`, so they are spent before anything is painted.

`logo/solid-icon-dark.png` is left at full resolution and is now the single
heaviest file at 390 KB: it is the giant background mark, drawn at `230vmax`,
already upscaled from its source. Shrinking it is a visual call, not a
mechanical one.

If you add an image, check what size it is rendered at before you commit it.

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
