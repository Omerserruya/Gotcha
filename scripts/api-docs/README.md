# API documentation generator

Produces `docs/openapi.yaml` and `docs/API_EXECUTION_MAP.md` from the source.

```bash
npm run api:docs          # regenerate both artifacts
npm run api:docs:check    # CI: fail if the committed docs no longer match the source
```

## Why generated and not written

There are 781 HTTP routes across nine services. A hand-written spec of that size
is wrong within a sprint, and nothing fails when it drifts: a route gets added, a
`requireRole("ADMIN")` gets removed, and the document keeps confidently
describing the old shape. Documentation that is quietly wrong about
**authorization** is worse than no documentation, because people act on it.

So the pipeline reads the code, and `api:docs:check` turns drift into a build
failure instead of a discovery.

## How it works

| Stage | Script | Output |
|---|---|---|
| 1. Extract | `extract-routes.ts` | `docs/.api-extract/route-inventory.json` (gitignored) |
| 2. Spec | `generate-openapi.ts` | `docs/openapi.yaml` |
| 3. Map | `generate-execution-map.ts` | `docs/API_EXECUTION_MAP.md` |
| 4. Guard | `check-drift.ts` | exit code |

`tag-map.json` maps path prefixes to domain tags and is shared by stages 2 and 3,
so the two documents can never disagree about which domain an endpoint is in.

### Extraction

`extract-routes.ts` parses TypeScript ASTs (no regex, no runtime import, no
database). For each service it reads `src/index.ts` — and `src/app.ts`, which
voice-copilot uses instead — finds `app.use("<prefix>", router)`, resolves the
router back to its file, and walks it.

Four middleware patterns exist in this codebase, and **all four had to be handled
before the output was trustworthy**:

1. Per-route: `router.post("/x", authenticate, handler)`
2. Router-level: `router.use(authenticate, resolveTenant)` — applies to
   everything declared *after* it
3. Path-scoped: `router.use("/funnels", authenticate, ...)` — applies only under
   that prefix
4. Spread arrays: `router.get("/users", ...ADMIN_ONLY, handler)`

Missing (3) and (4) made **57 authenticated routes report as anonymous**,
including admin-only billing endpoints. That is the exact failure mode this
generator exists to prevent, so the catch-all "unclassified middleware" branch is
treated as a bug: `auth.other` is expected to be empty, and anything landing
there means a middleware needs classifying in `classifyNamed()`.

### What each artifact is for

- **`openapi.yaml`** — what you can call. Importable into Swagger UI, Postman,
  Insomnia, or a client generator.
- **`API_EXECUTION_MAP.md`** — what happens when you do. Middleware order,
  service calls, Prisma models read and written, queues, and the background work
  that outlives the response.

## Browsing it in dev

Both are **dev-only** and defined solely in `docker-compose.yml` and
`nginx/nginx.conf.template`. `docker-compose.prod.yml` and
`gateway/nginx.prod.conf.template` contain no reference to either, so neither
exists in production - a structural absence, not a runtime flag someone could
flip.

| URL | What |
|---|---|
| `http://dev.gotcha.co.il/api/docs/` | Swagger UI |
| `http://dev.gotcha.co.il/api/docs/openapi.yaml` | The raw spec, for Postman / Insomnia / IDE plugins |
| `http://localhost:8088/` | The same UI standalone, no gateway needed |

```bash
docker compose up -d swagger-ui        # standalone, on :8088
docker compose up -d swagger-ui gateway # also served at /api/docs/
```

The standalone port is not redundant. The dev gateway refuses to start unless
**every** upstream resolves, so routing the docs exclusively through it would
make them unavailable precisely when half the stack is down and you most want to
look an endpoint up.

**No npm dependency was added.** `swagger-ui-express` was the obvious choice and
the wrong one here: this repo forbids new dependencies, and dev and prod share
one Docker runtime stage built with `npm ci --omit=dev`, so a devDependency
would not be installed in dev either - it would have to become a real dependency
shipped unused into all twelve production images. A compose service costs
production nothing and cannot reach it.

The UI and external tooling fetch the *same* URL: Swagger UI requests
`./openapi.yaml`, which resolves to `/api/docs/openapi.yaml` and is served by
nginx's exact-match rule straight off the mounted `docs/` directory. One file,
one URL, no second copy to drift.

## Known limits

These are properties of the codebase, not bugs in the generator. Each is stated
in the generated output too, so a reader is never misled:

- **No response schemas.** Nothing in this codebase declares response types;
  handlers call `res.json()` with ad-hoc objects. Successful responses are typed
  as `EnvelopeUnknown`, documenting the `{ data: ... }` convention without
  inventing a shape. Fixing this means adding schemas to the code.
- **333 request bodies have no Zod schema** and are flagged
  `x-documentation-gap: request-body-unschematized`. Those handlers read
  `req.body` directly, so nothing is enforced or knowable.
- **Database operations are handler-local.** Step 7 lists `prisma.*` calls in the
  handler itself. Work done inside a service it delegates to is not expanded; the
  service is named in step 6 so it can be followed.
- **Order is source order.** Branches and early returns mean the real sequence
  can skip steps.
- **Examples are not invented.** Request examples appear only where a Zod schema
  supplies enough to derive one.

## Extending it

- New middleware → add a branch to `classifyNamed()` in `extract-routes.ts`.
- New domain tag → add a prefix to `tag-map.json`.
- More Zod constructs → extend `zodToJsonSchema()`. Unrecognised validators
  degrade to `{}` rather than guessing a type.
