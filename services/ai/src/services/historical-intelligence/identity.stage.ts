import { prisma, normalizePhone, withHistoricalRecords } from "@chatcenter/shared";
import { getSourceOfTruth } from "../connectors/source-of-truth";
import { recordEvent, type StageResult } from "./stage-utils";

/**
 * Resolve imported participants to customers GOTCHA and the business already
 * know about.
 *
 * ── The rule this stage exists to keep ──
 *
 * Linking is not creation. Nothing in here may bring a customer into being in
 * Shopify, a CRM, or any other system of record. A business that imports its
 * WhatsApp history and finds twelve hundred new "customers" in its Shopify
 * admin the next morning has been damaged by us, not helped: their segments,
 * their marketing lists, their reporting and possibly their billing all move.
 *
 * That rule is enforced by construction rather than by care. Lookups go through
 * `getSourceOfTruth()`, whose `SourceOfTruthProvider` interface exposes
 * `identifyCustomer` and has NO create method of any kind. `createLead` and
 * Shopify's `customerCreate` live on the raw `CRMAdapter` beneath the facade,
 * which this file never obtains and cannot reach. An edit that tried to create
 * an external customer here would not compile - which is a far better guarantee
 * than a comment asking future readers not to.
 *
 * GOTCHA's own contacts are not created either, for a different reason: a
 * Contact is a live object that shows up in contact lists, segments and
 * broadcast audiences, and manufacturing twelve hundred of them out of history
 * would change the customer's product without being asked. Existing contacts
 * are linked and may be gently enriched; absent ones simply stay absent, and
 * the live path creates them the moment that person writes again.
 */

/** External lookups run a few at a time. See `CONCURRENCY` below. */
const CONCURRENCY = 4;

/**
 * A vendor lookup that is merely slow must not be able to stall the stage. Six
 * seconds is generous for a single customer search and still bounds the worst
 * case for a thousand of them.
 */
const LOOKUP_TIMEOUT_MS = 6000;

export async function runIdentityStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const customers = await prisma.historicalCustomer.findMany({
    where: { importId, tenantId },
    select: { id: true, externalId: true, normalizedPhone: true, contactId: true },
  });

  // The tenant's elected system of record, or null when they have none
  // connected. Null is a completely normal answer and simply means the
  // Shopify-match statistics will be zero - never a reason to fail the stage.
  let sourceOfTruth: Awaited<ReturnType<typeof getSourceOfTruth>> = null;
  try {
    sourceOfTruth = await getSourceOfTruth(tenantId);
  } catch (err: any) {
    console.warn(`[historical-intelligence] source-of-truth unavailable: ${err?.message}`);
  }
  const canIdentify = !!sourceOfTruth && sourceOfTruth.supports("identify_customer");

  let matchedContacts = 0;
  let matchedSourceOfTruth = 0;
  let enriched = 0;
  let lookupFailures = 0;

  await forEachLimited(customers, CONCURRENCY, async (customer) => {
    const phone = customer.normalizedPhone || normalizePhone(customer.externalId);

    // ── 1. An existing GOTCHA contact ──
    const contact = await findExistingContact(tenantId, customer.externalId, phone);

    // ── 2. The business's own system of record. Read only. ──
    let vendor: string | null = null;
    let vendorCustomerId: string | null = null;
    if (canIdentify && phone) {
      try {
        const found = await withTimeout(
          sourceOfTruth!.identifyCustomer({ phone }),
          LOOKUP_TIMEOUT_MS,
        );
        // Adapters report "found nothing" as ok with no id, which is a result
        // and not a failure. Only a throw or a timeout counts as a failure.
        const id = (found as any)?.customer?.id ?? (found as any)?.id ?? null;
        if (found?.ok && id) {
          vendor = sourceOfTruth!.vendor;
          vendorCustomerId = String(id);
          matchedSourceOfTruth += 1;
        }
      } catch {
        lookupFailures += 1;
      }
    }

    if (contact) matchedContacts += 1;

    await prisma.historicalCustomer.update({
      where: { id: customer.id },
      data: {
        normalizedPhone: phone || null,
        contactId: contact?.id ?? null,
        displayName: contact?.displayName ?? null,
        sourceOfTruthVendor: vendor,
        sourceOfTruthCustomerId: vendorCustomerId,
        sourceOfTruthMatchedAt: vendorCustomerId ? new Date() : null,
      },
    });

    if (contact && (await enrichContactFromHistory(tenantId, contact.id, customer.id))) {
      enriched += 1;
    }
  });

  await prisma.historicalImport.update({
    where: { id: importId },
    data: {
      importedCustomers: customers.length,
      customersTotal: customers.length,
      matchedExistingCustomers: matchedContacts,
      matchedSourceOfTruth,
      status: "CUSTOMER_LEARNING",
    },
  });

  const detail = {
    customers: customers.length,
    matchedContacts,
    matchedSourceOfTruth,
    enrichedContacts: enriched,
    lookupFailures,
    sourceOfTruthVendor: sourceOfTruth?.vendor ?? null,
    // Stated explicitly because it is the property most worth being able to
    // prove after the fact, and an audit trail that only records successes
    // cannot prove an absence.
    externalRecordsCreated: 0,
  };

  await recordEvent(
    importId,
    "IDENTITY_RESOLUTION",
    lookupFailures > 0 ? "PARTIAL" : "SUCCESS",
    null,
    detail,
    Date.now() - startedAt,
  );

  return { ok: true, detail };
}

/**
 * An existing contact for this person, by channel id first and then by phone.
 *
 * The phone fallback matters: the same human may already exist as an Instagram
 * or email contact, and the whole point of normalizing is that
 * "0501234567" and "+972501234567" must not become two people.
 */
async function findExistingContact(
  tenantId: string,
  externalId: string,
  phone: string,
): Promise<{ id: string; displayName: string | null } | null> {
  const { resolveContactByChannelId } = await import("@chatcenter/shared");
  try {
    const direct = await resolveContactByChannelId(tenantId, "WHATSAPP", externalId);
    if (direct) return { id: direct.id, displayName: direct.displayName ?? null };
  } catch {
    // fall through to the phone probe
  }
  if (!phone) return null;
  const byPhone = await prisma.contact.findFirst({
    where: { tenantId, phone, mergedIntoId: null },
    select: { id: true, displayName: true },
  });
  return byPhone ? { id: byPhone.id, displayName: byPhone.displayName ?? null } : null;
}

/**
 * Fill in identifiers the conversations revealed, and ONLY where we hold
 * nothing already.
 *
 * Two constraints shape this:
 *
 *   * Weaker data never overwrites stronger. An email a customer typed into a
 *     chat two years ago is worse evidence than one they verified, so an
 *     occupied field is left exactly as it is.
 *   * Nothing discovered here is written outward. It updates GOTCHA's own
 *     contact and stops there; pushing it to Shopify or a CRM would be the
 *     external mutation this whole feature is built to avoid.
 *
 * Provenance is stamped on every value so a wrong one can be found later and
 * attributed.
 */
async function enrichContactFromHistory(
  tenantId: string,
  contactId: string,
  historicalCustomerId: string,
): Promise<boolean> {
  const record = await prisma.historicalCustomer.findUnique({
    where: { id: historicalCustomerId },
    select: { conversationId: true },
  });
  if (!record?.conversationId) return false;

  const bodies = await withHistoricalRecords(() =>
    prisma.message.findMany({
      where: { tenantId, conversationId: record.conversationId!, direction: "INBOUND" },
      select: { body: true },
      take: 400,
      orderBy: { createdAt: "asc" },
    }),
  );

  const discovered = discoverIdentifiers(bodies.map((b) => b.body));
  if (!discovered.email && !discovered.instagram) return false;

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: { email: true, metadata: true },
  });
  if (!contact) return false;

  const patch: Record<string, unknown> = {};
  if (discovered.email && !contact.email) patch.email = discovered.email;

  const metadata =
    contact.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
      ? (contact.metadata as Record<string, unknown>)
      : {};
  if (discovered.instagram && !metadata.instagramHandle) {
    patch.metadata = {
      ...metadata,
      instagramHandle: discovered.instagram,
      instagramHandleSource: "historical_whatsapp_import",
    };
  }
  if (Object.keys(patch).length === 0) return false;

  // `emailVerified` is deliberately NOT set. The customer typed this into a
  // chat; nobody confirmed it, and marking it verified would let it be used
  // for things that require a verified address.
  if (patch.email) {
    patch.source = "historical_whatsapp_import";
  }

  await prisma.contact.updateMany({ where: { id: contactId, tenantId }, data: patch as any });
  await prisma.historicalCustomer.update({
    where: { id: historicalCustomerId },
    data: {
      discoveredIdentities: {
        ...(discovered.email ? { email: discovered.email } : {}),
        ...(discovered.instagram ? { instagramHandle: discovered.instagram } : {}),
        source: "historical_whatsapp_import",
        discoveredAt: new Date().toISOString(),
      },
    },
  });
  return true;
}

/**
 * Deterministic extraction, on purpose.
 *
 * An email address and an Instagram handle have exact syntax, so a regex finds
 * them with no cost, no latency and no chance of invention. Asking a model to
 * "find the customer's email" in two thousand messages would be slower, dearer,
 * and occasionally confident about an address that was never written.
 */
function discoverIdentifiers(bodies: string[]): { email?: string; instagram?: string } {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const INSTAGRAM = /(?:^|\s)@([A-Za-z0-9._]{3,30})(?=\s|$)/;
  let email: string | undefined;
  let instagram: string | undefined;
  for (const body of bodies) {
    if (!body) continue;
    if (!email) {
      const m = body.match(EMAIL);
      if (m) email = m[0].toLowerCase();
    }
    if (!instagram) {
      const m = body.match(INSTAGRAM);
      // "@" is also how people address each other and how prices get written.
      // Requiring a plausible handle shape keeps "@10" and "@here" out.
      if (m && /[A-Za-z]/.test(m[1])) instagram = m[1];
    }
    if (email && instagram) break;
  }
  return { email, instagram };
}

// ─── Small utilities ─────────────────────────────────────────

async function forEachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await fn(items[index]);
      } catch (err: any) {
        // One customer failing must not cost the other twelve hundred.
        console.warn(`[historical-intelligence] identity item failed: ${err?.message}`);
      }
    }
  });
  await Promise.all(workers);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lookup timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
