# Components that are finished and on no page

Found by `npx tsx scripts/orphan-component-sweep.ts`, which lists exported
components that nothing outside their own file imports.

## Why this file exists

`TeamLoad` and `AskedAbout` were built for screen 06, each with a passing test
file, and **imported by nothing**. `/analytics` was still the placeholder stub.
Analytics was reported as finished on the strength of three commits and a green
suite — and one of those three had gone onto screen 01 instead.

Every artefact was correct. The screen did not exist. It is the same shape as
the three i18n catalogues that no loader enumerated: **every test read the
artefact and nothing read the wiring.**

A component with a passing test and no importer is finished and absent, and
nothing in a test run, a build, a lint pass or a type check disagrees.

## The five that remain, as of 2026-09-27

Screen 06's two are now mounted. These are not, and **both of their screens
have passing captures** — so those captures photograph a partial screen and
report success, which is the same failure one layer along.

| Component | Screen | Note |
| --- | --- | --- |
| `ConnectNumbers` | 13 · Settings · Channels | has a test |
| `ImportProgress` | 13 · Settings · Channels | has a test |
| `KnowledgeReview` | 13 · Settings · Channels | has a test |
| `PersonPanel` | 12b · People · Roles | has a test |
| `RemovePermission` | 12b · People · Roles | has a test |

`RemovePermission` is worth its own line: a control that removes a permission
is a **write**, and an unmounted write is not a dormant feature — it is a
behaviour somebody believes exists. Whether it should be mounted is a question
for whoever ruled on that screen, not something to wire in on the strength of
finding it.

`Dialog` (a design-system primitive) is also unimported. Three of the five
above read like drawer or dialog contents, so it is possible the wiring was one
piece and all four went missing together.

## What is legitimately unimported

The sweep prints rather than fails, because a component can honestly be ahead
of its screen — built against an agreed design while the route waits on a
ruling. Turning that into a red gate would push somebody to mount a
placeholder to silence it, which is the defect and not the fix.

Most of the design system is in the list for that reason: `Popover`,
`ContextMenu`, `Tabs`, `Skeleton`, `Tooltip`. A design system exports ahead of
use by design.

So the rule is: **mount it, or say in its own file why it is waiting.** The
second is a real answer. Silence is not.
