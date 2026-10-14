/**
 * /api/workspace - the business facts an AI employee quotes, in one place.
 *
 * WHY AUTH OWNS THIS
 * Both sources already live here: `BusinessProfile` (onboarding.ts) and the
 * `businessHours` durable setting (agents.ts). Composing them anywhere else
 * would mean a network hop for data sitting in the next file. Prohibited
 * claims moved here for the same reason - the AI service READS that policy,
 * but the settings screen WRITES it, and writing is what decides ownership.
 * One owner also means one nginx location for /api/workspace, rather than a
 * rule per path that the next person has to remember to add.
 *
 * The one thing that cannot live here is the voice SAMPLE, which needs a model
 * call, and new model calls belong only in services/ai. So that endpoint is
 * served here and delegates over the internal API - the screen still sees one
 * /api/workspace surface, and the rule is not bent.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  readDurableSetting,
  writeDurableSetting,
  getPolicy,
  setPolicy,
  validateStringList,
  PolicyValidationError,
} from "@chatcenter/shared";

const router = Router();

/**
 * Reachable during onboarding. These are the facts a workspace fills in on its
 * way to being live, so gating them on being live already would be the same
 * chicken-and-egg the setup endpoints had.
 */
router.use("/workspace", authenticate, resolveTenant, requireOnboardingOrActiveTenant());

const READ = requirePermission("settings:workspace:read");
const WRITE = requirePermission("settings:workspace:update");

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");
import { readProvenance, fieldSources, stampProvenance } from "../services/field-provenance.service";
import { startProfileRescan, readScanRun, acceptScanProposal, type ScanRun } from "../services/business-scan.service";
const VOICE_MIN = 40;
const VOICE_MAX = 1800;

// ─── Shape helpers ────────────────────────────────────────────

type Hours = Record<string, unknown> | null;

async function readHours(tenantId: string): Promise<Hours> {
  const raw = await readDurableSetting(tenantId, "businessHours");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A setting that will not parse is a setting nobody can act on. Reported
    // as absent rather than thrown: the rest of the workspace is still
    // readable, and the screen shows hours as unset, which is recoverable.
    console.warn("[workspace] businessHours did not parse; reporting as unset");
    return null;
  }
}

function composeWorkspace(profile: any, hours: Hours, tenantName: string | null) {
  const h = (hours ?? {}) as Record<string, any>;
  return {
    // Falls back to the tenant's own name: a workspace that has not completed
    // the business profile still has a name, and showing an empty heading
    // would read as data loss rather than as an unfinished step.
    name: profile?.organizationName ?? tenantName ?? null,
    description: profile?.businessDescription ?? null,
    websiteDomain: profile?.websiteDomain ?? null,
    industry: profile?.industry ?? null,
    country: profile?.country ?? null,
    // A LIST, because the screen says "Hebrew and English, answers in the
    // customer's language" and one value cannot say that. Today it is the
    // single stored language wrapped in an array - the shape is right before
    // the second field exists, so the client never has to change.
    languages: profile?.primaryLanguage ? [profile.primaryLanguage] : [],
    currency: profile?.currency ?? null,
    address: profile?.address ?? null,
    timezone: typeof h.timezone === "string" ? h.timezone : null,
    hours: hours
      ? {
          enabled: h.enabled === true,
          schedule: h.schedule ?? null,
          aiOutsideHours: h.aiOutsideHours ?? "active",
          outsideHoursHandoffMessage: h.outsideHoursHandoffMessage ?? "",
        }
      : null,
    updatedAt: newerOf(profile?.updatedAt ?? null, h.updatedAt ?? null),
  };
}

/**
 * The later of the two sources' timestamps.
 *
 * This is the value `If-Match` is checked against, so it has to move when
 * EITHER source moves - a concurrency check that only watches one of two
 * writable sources is a check that misses half the conflicts.
 */
function newerOf(a: Date | string | null, b: Date | string | null): string | null {
  const ta = a ? new Date(a).getTime() : 0;
  const tb = b ? new Date(b).getTime() : 0;
  const max = Math.max(ta, tb);
  return max > 0 ? new Date(max).toISOString() : null;
}

async function loadWorkspace(tenantId: string) {
  const [profile, hours, tenant, provenance] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { tenantId } }),
    readHours(tenantId),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    readProvenance(tenantId),
  ]);
  return {
    ...composeWorkspace(profile, hours, tenant?.name ?? null),
    // Which fields came from the website scan and which a person typed, so the
    // screen can mark them and a rescan can be honest about what it may touch.
    // `null` means UNKNOWN, not "from website" - see field-provenance.service.
    fieldSources: fieldSources(provenance),
  };
}

// ─── §2 · the workspace ───────────────────────────────────────

router.get("/workspace", READ, async (req: Request, res: Response) => {
  try {
    res.json({ data: await loadWorkspace(req.tenantId!) });
  } catch (err) {
    console.error("workspace read error:", err);
    res.status(500).json({ error: "Failed to read workspace" });
  }
});

interface FieldError { field: string; message: string }

/**
 * A website as onboarding stores it: the origin, lowercased host, scheme kept
 * (https assumed when none is typed). Only http(s), and only a real host name -
 * not an IP or a bare word.
 */
export function normalizeWebsite(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return null;
  }
}

router.patch("/workspace", WRITE, async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];

  // website, industry and country joined the editable set (2026-10-11: "can't
  // change the business details there"). Saving a website NEVER starts a
  // re-scan; "Scan again" (POST /workspace/scan) stays the only way.
  const known = new Set(["name", "description", "address", "currency", "languages", "timezone", "hours", "website", "industry", "country"]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) errors.push({ field: key, message: `unknown field "${key}"` });
  }

  const str = (field: string, max: number, min = 1): string | undefined => {
    if (!(field in body)) return undefined;
    const v = body[field];
    if (typeof v !== "string") { errors.push({ field, message: `${field} must be a string` }); return undefined; }
    const t = v.trim();
    if (t.length < min || t.length > max) {
      errors.push({ field, message: `${field} must be between ${min} and ${max} characters` });
      return undefined;
    }
    return t;
  };

  const name = str("name", 200);
  const description = str("description", 2000);
  const address = "address" in body && body.address === null ? null : str("address", 300, 0);

  let currency: string | null | undefined;
  if ("currency" in body) {
    const v = body.currency;
    if (v === null) currency = null;
    else if (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim())) currency = v.trim().toUpperCase();
    else errors.push({ field: "currency", message: "currency must be a three-letter ISO-4217 code, or null" });
  }

  // Stored as the origin, the same form onboarding writes (https://host).
  let website: string | null | undefined;
  if ("website" in body) {
    const v = body.website;
    if (v === null || (typeof v === "string" && !v.trim())) website = null;
    else if (typeof v === "string") {
      const n = normalizeWebsite(v);
      if (n) website = n;
      else errors.push({ field: "website", message: "website must be an http(s) address, like https://example.com" });
    } else errors.push({ field: "website", message: "website must be a string, or null" });
  }

  // The column is required, so it can be changed but not cleared; a free
  // string up to 120 characters, as onboarding takes it.
  const industry = str("industry", 120);

  let country: string | null | undefined;
  if ("country" in body) {
    const v = body.country;
    if (v === null) country = null;
    else if (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim())) country = v.trim().toUpperCase();
    else errors.push({ field: "country", message: "country must be a two-letter ISO-3166 code, or null" });
  }

  let languages: string[] | undefined;
  if ("languages" in body) {
    const v = body.languages;
    if (!Array.isArray(v) || v.some((l) => typeof l !== "string")) {
      errors.push({ field: "languages", message: "languages must be an array of language codes" });
    } else if (v.length > 1) {
      // ★ REFUSED BECAUSE ONLY ONE CAN BE STORED. The validator used to accept
      // six and the writer kept `languages[0]`, so a caller adding English
      // beside Hebrew got a 200 and lost English. The response is a re-read, so
      // it came back as a one-element array: the loss was visible only to a
      // caller that diffed the response against what it sent, and invisible to
      // anything that did the normal thing and trusted the success.
      //
      // The ARRAY SHAPE is deliberate and stays - it is the contract for when a
      // second column exists, and moving to one string now would break every
      // client twice. What was wrong was not the shape but the promise: an
      // endpoint that says yes to something it will not do.
      //
      // So the shape is forward-compatible and the capacity is honest. Raising
      // this limit is a migration (a real column for the list), which is a
      // deliberate decision rather than a validator tweak.
      errors.push({
        field: "languages",
        message: "languages accepts one entry today; additional entries would not be stored",
      });
    } else {
      languages = v.map((l) => String(l).trim().toLowerCase()).filter(Boolean);
    }
  }

  if (errors.length > 0) {
    res.status(422).json({ error: "Invalid workspace patch", details: errors });
    return;
  }

  try {
    const current = await loadWorkspace(tenantId);

    // Optimistic concurrency. Only enforced when the caller sends If-Match:
    // an editor that has read the record can prove it is not overwriting
    // someone else, and a script that has not is not forced to pretend it did.
    const ifMatch = req.headers["if-match"];
    if (typeof ifMatch === "string" && ifMatch.trim() && current.updatedAt) {
      if (ifMatch.replace(/"/g, "").trim() !== current.updatedAt) {
        res.status(409).json({ error: "The workspace changed since you loaded it", code: "STALE_WRITE" });
        return;
      }
    }

    const profilePatch: Record<string, unknown> = {};
    if (name !== undefined) profilePatch.organizationName = name;
    if (description !== undefined) profilePatch.businessDescription = description;
    if (address !== undefined) profilePatch.address = address;
    if (currency !== undefined) profilePatch.currency = currency;
    if (website !== undefined) profilePatch.websiteDomain = website;
    if (industry !== undefined) profilePatch.industry = industry;
    if (country !== undefined) profilePatch.country = country;
    // Stored as the single column that exists. The list is the contract; the
    // storage catching up is a later change that will not move the shape.
    //
    // Safe to take `[0]` and drop nothing, because a list longer than one is
    // REFUSED above rather than silently truncated here. Those two lines are one
    // decision: if the limit moves, this is the line that has to be able to
    // honour it.
    if (languages !== undefined) profilePatch.primaryLanguage = languages[0] ?? null;

    if (Object.keys(profilePatch).length > 0) {
      // The stored values come back with the existence check, so comparing costs
      // no extra query.
      const existing = await prisma.businessProfile.findUnique({
        where: { tenantId },
        select: {
          id: true,
          organizationName: true,
          businessDescription: true,
          address: true,
          currency: true,
          primaryLanguage: true,
          websiteDomain: true,
          industry: true,
          country: true,
        },
      });
      if (!existing) {
        res.status(409).json({
          error: "This workspace has no business profile yet; complete onboarding first",
          code: "NO_BUSINESS_PROFILE",
        });
        return;
      }

      /**
       * Which fields a person actually CHANGED, as opposed to submitted.
       *
       * ★ THE WRITE STAYS UNCONDITIONAL AND ONLY THE STAMP IS GATED, and those
       * are different decisions. Re-writing an identical value is how a caller
       * moves `updatedAt` on purpose - the frontend's own conflict capture
       * PATCHes the description back unchanged so an ETag conflict is real and
       * photographable - so skipping the write would break a legitimate caller.
       *
       * Stamping it would be wrong for a much more ordinary reason: a person who
       * opens the screen and presses Save without editing anything would mark
       * every field as theirs, and a rescan would then only ever OFFER those
       * fields instead of refreshing them. "A human set this value" is not the
       * same claim as "a human submitted a form containing this field".
       *
       * Compared against the STORED COLUMNS rather than the composed response,
       * because the composed `name` falls back to the tenant's name when the
       * profile has none - so a first real write of `organizationName` looks
       * unchanged in the view while genuinely changing the column.
       *
       * Both directions of getting this wrong are non-destructive: an unstamped
       * field reads as UNKNOWN, and unknown is offered rather than applied, so a
       * missed stamp cannot let a rescan overwrite anybody's edit.
       */
      const changed = Object.keys(profilePatch).filter(
        (k) => profilePatch[k] !== (existing as Record<string, unknown>)[k],
      );

      await prisma.businessProfile.update({ where: { tenantId }, data: profilePatch as never });
      // Stamped in the same request that writes the value. This is the ONLY
      // place a person edits these fields, which is what makes one stamp site
      // enough - and a value saved without its mark would leave the field
      // unknown, so the next rescan would offer a change the owner already
      // made by hand.
      await stampProvenance(tenantId, changed, "human", (req as any).user?.userId);
    }

    if ("hours" in body || "timezone" in body) {
      const existingHours = (await readHours(tenantId)) ?? {};
      // `hours` is REPLACED, never merged. It is one setting describing a
      // whole week, and merging a partial week onto a stored one produces a
      // schedule nobody wrote and nobody can predict.
      const nextHours: Record<string, unknown> = "hours" in body && body.hours && typeof body.hours === "object"
        ? { ...(body.hours as Record<string, unknown>) }
        : { ...existingHours };
      if ("timezone" in body) {
        if (typeof body.timezone !== "string" || !body.timezone.trim()) {
          res.status(422).json({ error: "Invalid workspace patch", details: [{ field: "timezone", message: "timezone must be a string" }] });
          return;
        }
        nextHours.timezone = body.timezone.trim();
      } else if (existingHours.timezone) {
        nextHours.timezone = existingHours.timezone;
      }
      nextHours.updatedAt = new Date().toISOString();
      await writeDurableSetting(tenantId, "businessHours", JSON.stringify(nextHours), (req as any).user?.userId);
    }

    res.json({ data: await loadWorkspace(tenantId) });
  } catch (err) {
    console.error("workspace patch error:", err);
    res.status(500).json({ error: "Failed to update workspace" });
  }
});

// ─── §3 · voice ───────────────────────────────────────────────

router.get("/workspace/voice", READ, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
      select: { observedVoice: true, observedVoiceEditedAt: true, updatedAt: true },
    });
    const guidance = profile?.observedVoice?.trim() || null;
    res.json({
      data: {
        guidance,
        // Three states, not two: nothing learned yet is a different thing from
        // learned-and-left-alone, and the screen offers a different action for
        // each. `edited` is what the import pipeline refuses to overwrite.
        source: !guidance ? "none" : profile?.observedVoiceEditedAt ? "edited" : "learned",
        editedAt: profile?.observedVoiceEditedAt?.toISOString() ?? null,
        basis: { messagesAnalysed: null, importedAt: null },
      },
    });
  } catch (err) {
    console.error("voice read error:", err);
    res.status(500).json({ error: "Failed to read voice" });
  }
});

router.put("/workspace/voice", WRITE, async (req: Request, res: Response) => {
  try {
    const raw = (req.body ?? {}).guidance;
    if (typeof raw !== "string") {
      res.status(422).json({ error: "Invalid voice", details: [{ field: "guidance", message: "guidance must be a string" }] });
      return;
    }
    const guidance = raw.trim();

    // Empty is a REVERT, not a delete: clearing the edit stamp lets the next
    // import learn the voice again. Saying so in the response matters, because
    // "we threw your text away" and "we handed this back to the learner" look
    // identical from a blank box.
    if (!guidance) {
      const profile = await prisma.businessProfile.update({
        where: { tenantId: req.tenantId! },
        data: { observedVoice: null, observedVoiceEditedAt: null },
        select: { observedVoice: true },
      });
      res.json({
        data: {
          guidance: profile.observedVoice ?? null,
          source: "none",
          editedAt: null,
          basis: { messagesAnalysed: null, importedAt: null },
          reverted: true,
        },
      });
      return;
    }

    if (guidance.length < VOICE_MIN || guidance.length > VOICE_MAX) {
      res.status(422).json({
        error: "Invalid voice",
        details: [{ field: "guidance", message: `guidance must be between ${VOICE_MIN} and ${VOICE_MAX} characters` }],
      });
      return;
    }

    // The edit stamp is set in the SAME write, and that is the whole point:
    // the import pipeline refuses to overwrite an edited voice by reading this
    // column, so a write that set the text without the stamp would silently
    // re-arm the overwrite the mechanism exists to prevent.
    const updated = await prisma.businessProfile.update({
      where: { tenantId: req.tenantId! },
      data: { observedVoice: guidance, observedVoiceEditedAt: new Date() },
      select: { observedVoice: true, observedVoiceEditedAt: true },
    });

    res.json({
      data: {
        guidance: updated.observedVoice,
        source: "edited",
        editedAt: updated.observedVoiceEditedAt?.toISOString() ?? null,
        basis: { messagesAnalysed: null, importedAt: null },
      },
    });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(409).json({ error: "This workspace has no business profile yet", code: "NO_BUSINESS_PROFILE" });
      return;
    }
    console.error("voice write error:", err);
    res.status(500).json({ error: "Failed to save voice" });
  }
});

// ─── §4 · sample ──────────────────────────────────────────────

router.post("/workspace/voice/sample", WRITE, async (req: Request, res: Response) => {
  const guidance = (req.body ?? {}).guidance;
  if (typeof guidance !== "string" || !guidance.trim()) {
    res.status(422).json({ error: "Invalid sample request", details: [{ field: "guidance", message: "guidance is required" }] });
    return;
  }
  try {
    // Delegated, not reimplemented: a new model call belongs in services/ai.
    // The DRAFT is sent rather than read from storage, because the screen asks
    // "what would this do" before anyone commits to it.
    const upstream = await fetch(`${AI_SERVICE_URL}/api/internal/voice-sample`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY ?? "",
      },
      body: JSON.stringify({ tenantId: req.tenantId!, guidance: guidance.trim() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      // No fallback to canned text. A sample exists to show what this voice
      // will really do; a made-up one that the model never produced would be
      // the one thing worse than no preview at all.
      res.status(503).json({ error: "Could not generate a sample right now", code: "SAMPLE_UNAVAILABLE" });
      return;
    }
    const data = (await upstream.json().catch(() => null)) as { reply?: string } | null;
    if (!data?.reply) {
      res.status(503).json({ error: "Could not generate a sample right now", code: "SAMPLE_UNAVAILABLE" });
      return;
    }
    res.json({ data: { reply: data.reply } });
  } catch (err) {
    console.error("voice sample error:", (err as Error).message);
    res.status(503).json({ error: "Could not generate a sample right now", code: "SAMPLE_UNAVAILABLE" });
  }
});

// ─── §3b · scan again ─────────────────────────────────────────

/**
 * POST /api/workspace/scan - re-read the website and refresh what the scan owns.
 *
 * ★ IT ONLY WRITES FIELDS MARKED AS THE SCAN'S. Anything a person typed comes
 * back in `offer` with what the site now says, and is NOT written - along with
 * anything nobody ever marked, because the profile was seeded by an onboarding
 * step that never recorded which was which. `field-provenance.service` holds
 * the rule and the reasoning.
 *
 * Same crawler as onboarding (`crawlSite`) and the same model bridge, so a
 * rescan cannot start finding different things from the scan that filled these
 * fields in the first place.
 *
 * Every refusal is a 200 with a reason: "you have not told us your website yet"
 * and "the site did not answer" are sentences the screen shows, not errors it
 * has to decode. The exception is a scan already running, which is a 409 -
 * that one means try again shortly, and it shares onboarding's guard because
 * both drive the same crawl into the same row.
 */
router.post("/workspace/scan", WRITE, async (req: Request, res: Response) => {
  // ★ ANSWERS AT ONCE (2026-10-14). A rescan is a crawl plus a model call,
  // 25-40 seconds, and the browser and the BFF stop waiting at 20: the screen
  // said "the scan did not run" while it finished 20 seconds later. POST starts
  // it (202); GET /workspace/scan reports running, done or failed.
  try {
    const started = await startProfileRescan({
      tenantId: req.tenantId!,
      authHeader: req.headers.authorization ?? "",
      actorId: (req as any).user?.userId,
      locale: typeof (req.body ?? {}).locale === "string" ? (req.body as any).locale : undefined,
    });
    if (!started.started) {
      res.status(409).json({ error: "A scan is already running", code: "SCAN_IN_PROGRESS", data: scanRunView(started.run) });
      return;
    }
    res.status(202).json({ data: scanRunView(started.run) });
  } catch (err) {
    console.error("workspace scan error:", (err as Error).message);
    res.status(503).json({ error: "Could not scan the website right now", code: "SCAN_UNAVAILABLE" });
  }
});

/**
 * GET /api/workspace/scan - the last rescan: running, done or failed.
 *
 * done carries what was applied silently and what is offered to accept (the
 * same `applied` / `offer` the POST used to return), and `reach`: what the
 * crawl could see. failed carries the reason (no_domain, fetch_failed,
 * scan_failed, no_profile, internal_error, or timed_out for a run that never
 * finished). `run` is null when no rescan was ever started.
 */
router.get("/workspace/scan", READ, async (req: Request, res: Response) => {
  try {
    const run = await readScanRun(req.tenantId!);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: { run: run ? scanRunView(run) : null, fieldSources: fieldSources(await readProvenance(req.tenantId!)) } });
  } catch (err) {
    console.error("workspace scan status error:", (err as Error).message);
    res.status(500).json({ error: "Failed to read the scan status" });
  }
});

function scanRunView(run: ScanRun) {
  return {
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    reason: run.reason,
    applied: run.applied,
    offer: run.offer,
    reach: run.reach,
    knowledge: run.knowledge ?? null,
  };
}

/**
 * POST /api/workspace/scan/accept - take the website's value for offered fields.
 *
 * ★ STAMPS THE FIELD AS `scan`-OWNED, NOT `human`. Provenance answers one
 * question - may a future scan refresh this silently? - so it records what the
 * value TRACKS, not who clicked. Accepting the website's wording IS the consent a
 * silent refresh needs. A plain PATCH cannot be used for this and must not be:
 * PATCH means "a human set this" and has to keep meaning that, or the distinction
 * is lost in the other direction.
 *
 * Without this endpoint the mechanism had a fixed point at empty - `scan`
 * ownership was unreachable, so every scan offered everything and applied
 * nothing, forever. See field-provenance.service.
 *
 * The body carries FIELD NAMES ONLY. Values come from the stored proposal of the
 * last scan, so a client cannot mark arbitrary text as website-owned - which
 * matters because a scan may overwrite a scan-owned field without asking.
 */
router.post("/workspace/scan/accept", WRITE, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = body.fields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== "string")) {
    res.status(422).json({
      error: "Invalid accept request",
      details: [{ field: "fields", message: "fields must be a non-empty array of field names" }],
    });
    return;
  }

  try {
    const outcome = await acceptScanProposal(req.tenantId!, fields as string[], (req as any).user?.userId);
    if (!outcome.ok) {
      // 409, not 422: the request is well-formed and the state is wrong. "Scan
      // again first" is the action, and it is not a validation error.
      res.status(409).json({ error: "Nothing to accept", code: outcome.reason.toUpperCase() });
      return;
    }
    res.json({
      data: {
        accepted: outcome.accepted,
        // Named rather than dropped: a stale screen offering a field the last
        // scan did not propose must be told, not quietly told it worked.
        skipped: outcome.skipped,
        fieldSources: fieldSources(await readProvenance(req.tenantId!)),
      },
    });
  } catch (err) {
    console.error("workspace scan accept error:", (err as Error).message);
    res.status(500).json({ error: "Failed to accept the scan proposal" });
  }
});

// ─── §4b · learn ──────────────────────────────────────────────

/**
 * POST /api/workspace/voice/learn - learn the voice from what this business
 * has already written here.
 *
 * Until now a voice could only be learned by importing a WhatsApp history.
 * Most tenants never do, so for them the box could only be typed by hand.
 *
 * ★ IT LEARNS ONLY FROM MESSAGES A SIGNED-IN PERSON WROTE. Live outbound
 * traffic is overwhelmingly the product's own output - on this deployment,
 * 179 of 180 outbound messages - and learning from that would feed the model's
 * register back into the prompt that produces it, then show the result to the
 * customer as their own voice. `services/ai/src/services/live-voice.service.ts`
 * holds the rule and the reasoning.
 *
 * Every refusal comes back 200 with a `status` and the two counts, because
 * "your people have written 12 messages and we need 50" is a sentence the
 * screen has to show, not an error it has to interpret.
 */
router.post("/workspace/voice/learn", WRITE, async (req: Request, res: Response) => {
  try {
    // Delegated, not reimplemented: a new model call belongs in services/ai.
    // Generous timeout - this counts a corpus and then makes a model call,
    // where the sample endpoint only makes the call.
    const upstream = await fetch(`${AI_SERVICE_URL}/api/internal/voice-learn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY ?? "",
      },
      body: JSON.stringify({ tenantId: req.tenantId! }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok) {
      res.status(503).json({ error: "Could not learn the voice right now", code: "LEARN_UNAVAILABLE" });
      return;
    }
    const data = (await upstream.json().catch(() => null)) as
      | { status?: string; humanWritten?: number; machineWritten?: number; required?: number; guidance?: string; summary?: string }
      | null;
    if (!data?.status) {
      res.status(503).json({ error: "Could not learn the voice right now", code: "LEARN_UNAVAILABLE" });
      return;
    }

    res.json({
      data: {
        ...data,
        // `source` is reported the same way the GET reports it, so the screen
        // does not need a second rule for what it is looking at after a learn.
        source: data.status === "learned" ? "learned" : undefined,
      },
    });
  } catch (err) {
    console.error("voice learn error:", (err as Error).message);
    res.status(503).json({ error: "Could not learn the voice right now", code: "LEARN_UNAVAILABLE" });
  }
});

// ─── §5 · prohibited claims ───────────────────────────────────

router.get("/workspace/prohibited-claims", READ, async (req: Request, res: Response) => {
  try {
    const policy = await getPolicy(req.tenantId!);
    res.json({ data: { claims: policy.blockedTopics } });
  } catch (err) {
    console.error("prohibited-claims read error:", err);
    res.status(500).json({ error: "Failed to read prohibited claims" });
  }
});

router.put("/workspace/prohibited-claims", WRITE, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!("claims" in body)) {
      res.status(422).json({ error: "Invalid claims", details: [{ field: "claims", message: "claims is required" }] });
      return;
    }
    // The same validator the full-policy route in services/ai uses, so a rule
    // that is legal through one surface is legal through the other.
    const claims = validateStringList("claims", body.claims);
    // A patch of one field, not a write of the policy: the discount ceiling
    // and the refund rule share this blob and are none of this screen's
    // business.
    const policy = await setPolicy(req.tenantId!, { blockedTopics: claims });
    res.json({ data: { claims: policy.blockedTopics } });
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      res.status(422).json({ error: "Invalid claims", details: [{ field: err.field, message: err.message }] });
      return;
    }
    console.error("prohibited-claims write error:", err);
    res.status(500).json({ error: "Failed to save prohibited claims" });
  }
});

export default router;
