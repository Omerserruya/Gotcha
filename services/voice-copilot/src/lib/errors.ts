export class InvalidStateTransition extends Error {
  constructor(from: string, to: string) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = "InvalidStateTransition";
  }
}

export class SttOverloadError extends Error {
  constructor(count: number) {
    super(`STT overload: ${count} rate-limit errors in window`);
    this.name = "SttOverloadError";
  }
}

export class CrossTenantError extends Error {
  constructor(expected: string, got: string) {
    super(`Cross-tenant violation: expected ${expected}, got ${got}`);
    this.name = "CrossTenantError";
  }
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`Not implemented: ${feature}`);
    this.name = "NotImplementedError";
  }
}

export class DispatchDLQError extends Error {
  constructor(public readonly body: unknown) {
    super("Dispatch failed; item sent to DLQ");
    this.name = "DispatchDLQError";
  }
}

export class TwilioSignatureError extends Error {
  constructor() {
    super("Twilio signature validation failed");
    this.name = "TwilioSignatureError";
  }
}
