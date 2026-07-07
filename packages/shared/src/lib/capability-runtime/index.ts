/**
 * Capability Runtime — public surface (business contracts + pure resolver).
 *
 * Strategy / provider implementations (REST, Prisma, calendar SDKs) live in the
 * runtime layer (services/ai) and are injected via RuntimeBindings — they are
 * NEVER imported here, keeping the contract layer implementation-free.
 */

export * from "./contract";
export * from "./resolver";
