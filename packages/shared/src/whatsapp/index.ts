/**
 * WhatsApp onboarding and multi-number architecture.
 *
 * Layering, deliberately one-directional:
 *
 *   meta-types   pure shapes, no behaviour
 *   meta-client  official Graph endpoints, structured errors
 *   inspector    read-only sweep -> diagnostic model
 *   flow-selector  pure decision over the diagnostic model
 *
 * Nothing here writes to a database, so all of it is testable without one.
 * The services that DO write - onboarding pipeline, health engine, management
 * routes - live in services/auth and consume this package.
 */

export * from "./meta-types";
export * from "./meta-client";
export * from "./inspector";
export * from "./flow-selector";
export * from "./path-fallback";
export * from "./embedded-signup";
