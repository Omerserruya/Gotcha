/**
 * Automatic onboarding flow selection.
 *
 * Phase 4: given the inspector's diagnostic model, decide which official Meta
 * onboarding path a number needs. The customer is never asked, and never sees
 * the word WABA, phone number ID, business token or Graph API.
 *
 * This module is deliberately **pure**: no network, no database, no clock
 * beyond what it is handed. A flow decision is the highest-consequence
 * judgement in the whole feature - get it wrong and the customer walks a path
 * that cannot succeed - so it must be exhaustively unit-testable without a
 * Meta account.
 *
 * Reference: docs/integrations/whatsapp/01-meta-api-inventory.md
 */

import type { Blocker, InspectedNumber, InspectedWaba, MetaInspection } from "./inspector";

/** The five scenarios, plus the honest sixth. */
export type OnboardingScenario =
  /** A: brand new number. Create what is needed. */
  | "NEW_NUMBER"
  /** B: number lives in the WhatsApp Business app. Coexistence. */
  | "COEXISTENCE"
  /** C: number already on Cloud API. Reuse, never duplicate. */
  | "EXISTING_CLOUD_API"
  /** D: number GOTCHA already connected. Validate and repair. */
  | "RECONNECT"
  /** E: number must move between WABAs, and Meta supports it here. */
  | "MIGRATION"
  /** Nothing can proceed. `blockers` says why, in plain language. */
  | "BLOCKED";

/** Something only the customer can do. Mirrors WhatsAppPendingAction. */
export type CustomerAction =
  | "TWO_STEP_PIN"
  | "VERIFICATION_CODE"
  | "BUSINESS_APP_CONFIRMATION"
  | "BUSINESS_VERIFICATION"
  | "DISPLAY_NAME_REVIEW";

/** A step the pipeline will run without asking anyone. */
export type AutomatedStep =
  | "EXCHANGE_TOKEN"
  | "RESOLVE_ASSETS"
  | "SUBSCRIBE_WEBHOOKS"
  | "REGISTER_NUMBER"
  | "SYNC_PROFILE"
  | "HEALTH_CHECK";

export interface FlowDecision {
  scenario: OnboardingScenario;
  /** The number this decision is about, when one was identified. */
  phoneNumberId?: string;
  wabaId?: string;

  /** Engineering-facing. Goes to logs and the audit trail. */
  reason: string;
  /**
   * Customer-facing. One or two sentences, no Meta vocabulary. This is the
   * text the connect screen shows, so it says what will happen rather than
   * what we detected.
   */
  customerMessage: string;

  /** Steps we run automatically, in order. */
  automatedSteps: AutomatedStep[];
  /** What the customer must supply, if anything. Null when fully automatic. */
  customerAction: CustomerAction | null;
  blockers: Blocker[];

  /**
   * Present only when Meta genuinely supports moving this number and every
   * documented prerequisite is met. Absent means the option is NOT shown -
   * Phase 4's rule that unsupported options must never be exposed.
   */
  migrationOffer?: MigrationOffer;
}

export interface MigrationOffer {
  fromWabaId: string;
  toWabaId: string;
  /** Prerequisites verified against the inspection, each with its evidence. */
  verified: string[];
  /** Plain-language warning. Migration has irreversible side effects. */
  warning: string;
}

// ─── Coexistence: the Phase 6 choice ─────────────────────────

/**
 * The two options offered for a WhatsApp Business app number.
 *
 * Option 2 ("move completely to GOTCHA") is intentionally NOT a peer of option
 * 1. Meta publishes no API for moving a Business app number to Cloud API; the
 * documented path is for the customer to delete their WhatsApp account by
 * hand, which loses all message history and cannot be undone without
 * deregistering. Meta's own documentation recommends Coexistence instead.
 *
 * So `fullMigration.available` is false for every Business app number, and the
 * field exists to carry the honest explanation rather than to leave the
 * customer wondering whether they missed an option.
 *
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/migrate-existing-whatsapp-number-to-a-business-account/
 */
export interface BusinessAppOptions {
  keepUsingBusinessApp: {
    recommended: true;
    title: string;
    description: string;
    /** Meta caps Coexistence numbers at 20 messages per second. */
    throughputNote: string;
    limitations: string[];
  };
  fullMigration: {
    available: false;
    title: string;
    /** Why it is not offered, in the customer's language. */
    reason: string;
  };
}

export function businessAppOptions(): BusinessAppOptions {
  return {
    keepUsingBusinessApp: {
      recommended: true,
      title: "Keep using the WhatsApp Business app",
      description:
        "You carry on using WhatsApp Business on your phone exactly as you do now, and GOTCHA " +
        "works alongside it. Messages stay in sync both ways, and up to six months of your " +
        "existing conversations come across.",
      throughputNote:
        "Numbers used in both places send up to 20 messages per second, which is plenty for " +
        "conversations but lower than a GOTCHA-only number.",
      limitations: [
        "Group chats stay on your phone and will not appear in GOTCHA.",
        "Voice and video calls stay on your phone.",
        "Disappearing and view-once messages are not shared with GOTCHA.",
        "Broadcast lists stay on your phone.",
      ],
    },
    fullMigration: {
      available: false,
      title: "Move this number completely to GOTCHA",
      reason:
        "WhatsApp does not offer a way to move a number out of the WhatsApp Business app without " +
        "deleting the account on your phone first, which permanently erases your message history. " +
        "WhatsApp recommends running both side by side instead, so that is what we do.",
    },
  };
}

// ─── Selection ───────────────────────────────────────────────

/** Blockers that stop everything, as opposed to ones we work around. */
function fatalBlockers(blockers: Blocker[]): Blocker[] {
  const FATAL = new Set([
    "CONNECTED_ELSEWHERE",
    "ON_PREMISE",
    "PHONE_BANNED",
    "WEBHOOK_OVERRIDDEN",
  ]);
  return blockers.filter((b) => FATAL.has(b.code));
}

function blocked(reason: string, customerMessage: string, blockers: Blocker[]): FlowDecision {
  return {
    scenario: "BLOCKED",
    reason,
    customerMessage,
    automatedSteps: [],
    customerAction: null,
    blockers,
  };
}

/**
 * Is programmatic WABA-to-WABA migration genuinely available for this number?
 *
 * Every condition below is documented by Meta as mandatory. We check them ALL
 * and offer migration only when every one holds, because a migration that
 * fails halfway leaves the number verified against a WABA it no longer belongs
 * to, which is materially worse than never having started.
 *
 * https://developers.facebook.com/docs/whatsapp/business-management-api/guides/migrating-phone-numbers-between-wabas-programmatically
 */
export function evaluateMigration(
  number: InspectedNumber,
  sourceWaba: InspectedWaba | undefined,
  destinationWaba: InspectedWaba | undefined,
): MigrationOffer | null {
  if (!sourceWaba || !destinationWaba) return null;
  if (sourceWaba.wabaId === destinationWaba.wabaId) return null;

  const verified: string[] = [];

  // Meta: "Business phone numbers in use with the WhatsApp Business App
  // cannot be migrated using this process." Absolute, not a warning.
  if (number.isOnBizApp) return null;
  verified.push("Number is not in use with the WhatsApp Business app");

  if (number.kind !== "CLOUD_API") return null;
  verified.push("Number is registered on Cloud API");

  // Meta requires an approved display name with no pending change.
  if (number.nameStatus !== "APPROVED") return null;
  verified.push("Display name is approved");

  // Both WABAs must be business-verified and review-approved.
  if (sourceWaba.businessVerificationStatus !== "verified") return null;
  if (sourceWaba.accountReviewStatus !== "APPROVED") return null;
  verified.push("Current account is verified and approved");

  if (destinationWaba.businessVerificationStatus !== "verified") return null;
  if (destinationWaba.accountReviewStatus !== "APPROVED") return null;
  verified.push("Destination account is verified and approved");

  // Destination needs a payment method and an app already on its webhooks.
  if (!destinationWaba.hasPaymentMethod) return null;
  verified.push("Destination account has a payment method");

  if (!destinationWaba.appSubscribed) return null;
  verified.push("Destination account already receives messages");

  return {
    fromWabaId: sourceWaba.wabaId,
    toWabaId: destinationWaba.wabaId,
    verified,
    warning:
      "Moving the number keeps your approved message templates, but their quality ratings reset " +
      "and take about a day to rebuild. Templates that were rejected or still under review do " +
      "not move.",
  };
}

export interface SelectFlowOptions {
  inspection: MetaInspection;
  /**
   * The number the customer is connecting. When absent, the selector picks the
   * single obvious candidate if there is exactly one, and otherwise reports
   * that a choice is needed rather than guessing.
   */
  targetPhoneNumberId?: string;
  /** WABA the tenant already uses, when offering migration into it. */
  preferredWabaId?: string;
}

/**
 * Choose the flow. Deterministic: same inspection in, same decision out.
 */
export function selectFlow(opts: SelectFlowOptions): FlowDecision {
  const { inspection, targetPhoneNumberId, preferredWabaId } = opts;

  // A missing REQUIRED permission stops everything. Proceeding would produce
  // failures the customer cannot interpret, at a step they did not expect.
  const missingRequired = inspection.missingPermissions.filter(
    (p) => p === "whatsapp_business_management" || p === "whatsapp_business_messaging",
  );
  if (missingRequired.length > 0) {
    return blocked(
      `Missing required permissions: ${missingRequired.join(", ")}`,
      "GOTCHA was not given full permission to manage WhatsApp for your business. " +
        "Start the connection again and accept all the requested permissions.",
      missingRequired.map((p) => ({
        code: `MISSING_PERMISSION_${p.toUpperCase()}`,
        message: `The permission "${p}" was not granted.`,
        customerActionable: true,
      })),
    );
  }

  // ── Resolve which number we are deciding about ──
  const candidates = inspection.numbers;

  if (candidates.length === 0) {
    // Nothing exists yet. That IS Scenario A: signup creates the number.
    return {
      scenario: "NEW_NUMBER",
      reason: "No existing phone numbers found on any accessible WABA.",
      customerMessage:
        "We will set up a brand new WhatsApp number for your business. You will need a phone " +
        "number that is not already on WhatsApp, and you will get a verification code to enter.",
      automatedSteps: [
        "EXCHANGE_TOKEN",
        "RESOLVE_ASSETS",
        "SUBSCRIBE_WEBHOOKS",
        "REGISTER_NUMBER",
        "SYNC_PROFILE",
        "HEALTH_CHECK",
      ],
      customerAction: "VERIFICATION_CODE",
      blockers: [],
    };
  }

  let target: InspectedNumber | undefined;
  if (targetPhoneNumberId) {
    target = candidates.find((n) => n.phoneNumberId === targetPhoneNumberId);
    if (!target) {
      return blocked(
        `Target number ${targetPhoneNumberId} not present in inspection.`,
        "We could not find that number on your WhatsApp account. Try connecting again.",
        [],
      );
    }
  } else {
    // Prefer a number that is not yet connected here; connecting an already
    // connected number by accident is the most confusing possible outcome.
    const unconnected = candidates.filter((n) => !n.connectedToThisTenant);
    if (unconnected.length === 1) {
      target = unconnected[0];
    } else if (candidates.length === 1) {
      target = candidates[0];
    } else {
      // Several numbers and no choice made. Multi-number tenants hit this
      // constantly, and picking for them is exactly the bug being removed:
      // the old code connected EVERY number on the WABA.
      return {
        scenario: "BLOCKED",
        reason: `${candidates.length} candidate numbers; caller must choose one.`,
        customerMessage: "Choose which number you want to connect.",
        automatedSteps: [],
        customerAction: null,
        blockers: [
          {
            code: "CHOICE_REQUIRED",
            message: "You have more than one WhatsApp number. Pick the one to connect.",
            customerActionable: true,
          },
        ],
      };
    }
  }

  const fatal = fatalBlockers(target.blockers);
  if (fatal.length > 0) {
    return {
      ...blocked(
        `Fatal blockers on ${target.phoneNumberId}: ${fatal.map((b) => b.code).join(", ")}`,
        fatal[0].message,
        target.blockers,
      ),
      phoneNumberId: target.phoneNumberId,
      wabaId: target.wabaId,
    };
  }

  const base = { phoneNumberId: target.phoneNumberId, wabaId: target.wabaId };
  const sourceWaba = inspection.wabas.find((w) => w.wabaId === target!.wabaId);

  // ── Scenario D: we already have this one ──
  if (target.connectedToThisTenant) {
    const needsWork = target.blockers.length > 0;
    return {
      ...base,
      scenario: "RECONNECT",
      reason: needsWork
        ? `Already connected; ${target.blockers.length} blocker(s) to repair.`
        : "Already connected and healthy; revalidating.",
      customerMessage: needsWork
        ? "This number is already connected. We will check it over and fix what we can."
        : "This number is already connected and working.",
      automatedSteps: ["RESOLVE_ASSETS", "SUBSCRIBE_WEBHOOKS", "SYNC_PROFILE", "HEALTH_CHECK"],
      customerAction: firstCustomerAction(target),
      blockers: target.blockers,
    };
  }

  // ── Scenario B: WhatsApp Business app number ──
  // Checked BEFORE the plain Cloud API case: a Coexistence number is also
  // platform_type CLOUD_API, so testing that first would misroute every
  // Business app customer into a flow that skips their app entirely.
  if (target.kind === "COEXISTENCE") {
    return {
      ...base,
      scenario: "COEXISTENCE",
      reason: "platform_type=CLOUD_API with is_on_biz_app=true.",
      customerMessage:
        "This number is on the WhatsApp Business app. You can keep using the app on your phone " +
        "while GOTCHA works alongside it. WhatsApp will message you a code, and you tap Connect " +
        "in the app to confirm.",
      // Registration is deliberately absent. Meta: "skip the phone number
      // registration step, as the number is already registered." Sending a
      // Coexistence number to /register burns its 72-hour rate budget for
      // nothing.
      automatedSteps: ["EXCHANGE_TOKEN", "RESOLVE_ASSETS", "SUBSCRIBE_WEBHOOKS", "SYNC_PROFILE", "HEALTH_CHECK"],
      customerAction: "BUSINESS_APP_CONFIRMATION",
      blockers: target.blockers,
    };
  }

  // ── Scenario C: already on Cloud API ──
  if (target.kind === "CLOUD_API") {
    // Only consider migration when the tenant has a different WABA they use
    // AND every documented prerequisite passes. Otherwise the option is not
    // shown at all, per Phase 4.
    const destination = preferredWabaId
      ? inspection.wabas.find((w) => w.wabaId === preferredWabaId)
      : undefined;
    const migrationOffer = destination
      ? evaluateMigration(target, sourceWaba, destination) ?? undefined
      : undefined;

    return {
      ...base,
      scenario: "EXISTING_CLOUD_API",
      reason: "platform_type=CLOUD_API, not on the Business app, not connected here.",
      customerMessage:
        "This number is already set up with WhatsApp for business, so we will connect to it as " +
        "it is. Nothing will be recreated and your existing setup stays exactly where it is.",
      // No REGISTER_NUMBER: the number is already registered. Re-registering
      // would demand a two-step PIN we have no reason to ask for.
      automatedSteps: ["EXCHANGE_TOKEN", "RESOLVE_ASSETS", "SUBSCRIBE_WEBHOOKS", "SYNC_PROFILE", "HEALTH_CHECK"],
      customerAction: firstCustomerAction(target),
      blockers: target.blockers,
      ...(migrationOffer ? { migrationOffer } : {}),
    };
  }

  // ── Scenario E: migration, when it is genuinely supported ──
  if (preferredWabaId && target.kind !== "UNREGISTERED") {
    const destination = inspection.wabas.find((w) => w.wabaId === preferredWabaId);
    const offer = evaluateMigration(target, sourceWaba, destination);
    if (offer) {
      return {
        ...base,
        scenario: "MIGRATION",
        reason: `Migration prerequisites all satisfied from ${offer.fromWabaId} to ${offer.toWabaId}.`,
        customerMessage:
          "We will move this number onto your main WhatsApp business account. WhatsApp will send " +
          "a verification code to enter.",
        automatedSteps: ["EXCHANGE_TOKEN", "RESOLVE_ASSETS", "SUBSCRIBE_WEBHOOKS", "REGISTER_NUMBER", "SYNC_PROFILE", "HEALTH_CHECK"],
        customerAction: "VERIFICATION_CODE",
        blockers: target.blockers,
        migrationOffer: offer,
      };
    }
  }

  // ── Scenario A: exists on the account, never registered ──
  if (target.kind === "UNREGISTERED") {
    return {
      ...base,
      scenario: "NEW_NUMBER",
      reason: "Number present on the WABA but not registered for any API.",
      customerMessage:
        "We will finish setting this number up for business messaging. WhatsApp will send a " +
        "verification code to enter.",
      automatedSteps: [
        "EXCHANGE_TOKEN",
        "RESOLVE_ASSETS",
        "SUBSCRIBE_WEBHOOKS",
        "REGISTER_NUMBER",
        "SYNC_PROFILE",
        "HEALTH_CHECK",
      ],
      customerAction: needsTwoStepPin(target) ? "TWO_STEP_PIN" : "VERIFICATION_CODE",
      blockers: target.blockers,
    };
  }

  // ── Unknown platform_type ──
  // Meta shipped something this build has not seen. Say so instead of guessing
  // a flow; a wrong guess here writes real state against a customer's number.
  return {
    ...base,
    ...blocked(
      `Unrecognised platform_type "${target.platformType}" on ${target.phoneNumberId}.`,
      "We could not work out how this number is set up. Our team has been notified.",
      target.blockers,
    ),
  };
}

/**
 * A verified number that is not registered needs its two-step PIN, because
 * Meta requires the EXISTING PIN in the register call and publishes no way to
 * read or reset it.
 */
function needsTwoStepPin(number: InspectedNumber): boolean {
  return number.codeVerificationStatus === "VERIFIED" && number.kind === "UNREGISTERED";
}

/** The single most relevant thing to ask the customer for, or null. */
function firstCustomerAction(number: InspectedNumber): CustomerAction | null {
  if (number.blockers.some((b) => b.code === "NOT_VERIFIED")) return "VERIFICATION_CODE";
  if (number.blockers.some((b) => b.code === "NAME_DECLINED")) return "DISPLAY_NAME_REVIEW";
  if (
    number.blockers.some(
      (b) => b.customerActionable && b.code.startsWith("META_HEALTH_"),
    )
  ) {
    return "BUSINESS_VERIFICATION";
  }
  return null;
}
