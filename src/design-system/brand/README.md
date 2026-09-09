# Brand assets

## The two shapes

| File | What it is | Where it belongs |
|---|---|---|
| `mark.png` | The glyph alone - solid, no frame | Rail, favicon, anywhere small |
| `mark-framed.png` | The glyph inside its rounded-square outline | Brand sizes: sign-in, print, share images |

The split is about size, not preference. The frame is a thin stroke: at 16px
it closes into a smudge and at 24px it is mud. The solid glyph stays legible
down to a favicon. Using the framed shape in the rail would trade a readable
mark for an unreadable one.

## One file per shape, not per colour

Both are single-colour silhouettes, so `Logo` uses them as CSS masks and paints
with `currentColor`. The mark takes the colour of whatever contains it - light
on the dark rail, dark on a light panel, inherited inside a button.

**A white file and a black file are not needed, and are worse.** Two files
drift apart the moment the logo changes, and every call site has to decide
which one it is sitting on. The colour inside the file is discarded; only the
alpha channel is read.

## Replacing or adding

Drop the file here under the name above. Requirements:

- square-ish, ≥256px, **transparent background**
- a single solid colour - any colour, it is discarded
- trimmed to the artwork, or close to it: `Logo` does not crop

**An SVG is better.** Give one and the mask becomes a vector: sharp at every
size and a fraction of the weight (the PNGs are ~80KB each). It needs to be a
single filled path with no colours that matter.

## The favicon is generated, not linked

`src/app/icon.svg` is built from `mark.png` but is its own file, because a
favicon has to invert with `prefers-color-scheme` and has no React tree to
inherit a colour from. It is not regenerated automatically - if the mark
changes, say so and it gets rebuilt.
