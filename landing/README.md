# GOTCHA marketing site

The public site at `/`. Separate from `frontend/`, which is the application at
`app.` - different audience, different release cadence, different build. Nothing
is shared between them.

It is a **clone of the Claude Design project** "Redesigning GOTCHA landing from
scratch", not a reinterpretation of it. Every pixel, string and image comes from
that design; the port is produced by a compiler rather than by hand so that it
stays a clone when the design moves.

## Layout

```
design/                     the design sources, vendored so a rebuild is reproducible
  GOTCHA Landing.dc.html      template + logic + data, as authored
  he.js                       Hebrew dictionary, keyed by the English strings
  image-slots.state.json      the photos dropped into <image-slot> placeholders
tools/                      the compiler (see "Regenerating")
src/generated/              compiler output - do not edit
  Template.jsx                the design's template as JSX
  he.js                       the Hebrew dictionary as a module
  image-slots.json            slot id -> extracted photo + crop
src/app/globals.css         also generated: the design's <helmet> CSS plus the
                            style-<pseudo> rules as real classes
src/components/Landing.jsx  the design's own logic class, wrapped as a React component
src/lib/dc.tsx              four dc-runtime behaviours, reimplemented exactly
src/lib/pages.ts            page key -> URL
```

## Regenerating after a design change

Re-export the design project over `design/`, then:

```bash
npm run design:sync
```

That rewrites everything under `src/generated/`, plus
`src/components/Landing.jsx` and `src/app/globals.css`. Do not hand-edit those
files: the next sync overwrites them. Fix the design, or fix the compiler.

`globals.css` is generated for a reason worth remembering. It was hand-copied
once, and a stale copy fails silently - the page still renders, just with the
previous export's rules, and nothing in the build complains.

`design:sync` needs `parse5`, which today resolves through the shared
`node_modules`. It is a maintenance script, not part of `npm run build`, and its
output is committed - so a normal build never needs it.

## How the port works

The design is a "design canvas" document: an `x-dc` template with `{{ }}`
bindings driven by a `DCLogic` class. `DCLogic` mirrors React's class component
API (`state`, `setState`, `componentDidMount/DidUpdate/WillUnmount`), and the
runtime compiles the template to `React.createElement`, so the two halves port
across almost untouched:

| design | port |
|---|---|
| `<sc-for list="{{ e }}" as="x">` | `{$L(e).map((x, $index) => …)}` |
| `<sc-if value="{{ e }}">` | `{e ? … : null}` |
| `{{ e }}` in text | `{$I(e)}` - renders `<span class="sc-interp">`, as the runtime does |
| `{{ e }}` as a whole attribute | the raw value, so handlers stay functions |
| `{{ e }}` mixed into an attribute | a template literal joined with `?? ''` |
| `style="a:b"` | `$st("a:b")`, parsed the way `cssToObj` parses it |
| `style-hover="…"` | a generated `.scpN:hover` class, `!important`, deduped |
| `window.lucide` | the same UMD build, bundled so it also resolves on the server |

Three behaviours are load-bearing and easy to lose:

- **Every path hop is optional.** The runtime's `resolvePath` walks with
  `cur == null ? undefined : cur[key]`, and the design relies on it: a feature
  page still asks for `sol.kicker` while `sol` is null.
- **Whitespace text nodes survive** unless they are whitespace *without* a space
  character. That is the runtime's rule, and it changes inline layout.
- **Scalar interpolations are wrapped in a span.** Unstyled, but still a real
  inline box inside the design's many flex rows.

## What is deliberately not identical

- `<image-slot>` renders as a `div > img` reproducing the slot's crop, rather
  than as the design tool's custom element. Same box, same framing.
- The design keeps all 34 pages on one URL and switches them through
  `state.page`. Each page has a real address here, and is statically generated,
  so the site is linkable and indexable. The rendered page for a given key is
  unchanged.
- lucide is bundled instead of pulled from unpkg at runtime.
- Asset paths are rooted (`/assets/…`), which relative paths could not be once
  pages live under `/product/…`.

## Verifying a change

The design renders standalone. Serve `design/` over HTTP, open the `.dc.html`,
and compare against this app: element structure, text and geometry should match.
That comparison is what caught the optional-chaining and asset-path bugs during
the port.
