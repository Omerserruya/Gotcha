/**
 * Installation health: the channel flag is not proof.
 *
 * Found in production-adjacent dev, not in review. A merchant uninstalled the
 * old Chat Dev app while moving to the unified app. Shopify delivered
 * `app/uninstalled`, the handler correctly retired the installation
 * (`status = UNINSTALLED`), and the CHANNEL row was left untouched with
 * `enabled = true`.
 *
 * The result was two rows that disagreed. GOTCHA read the channel and showed
 * a healthy "enabled" toggle; the storefront bootstrap resolves through the
 * INSTALLATION and refused with `{"error":"unavailable"}`. Toggling in the UI
 * ran the save path, which rewrites the channel flag and never touches the
 * installation, so the merchant could flip the switch forever and nothing
 * would change.
 *
 * These tests pin the rule that prevents it: any degraded installation state
 * demands the full enable/reconciliation flow, and `enabled` alone may never
 * be treated as evidence that storefront chat works.
 */
import { describe, it, expect } from "vitest";
import {
  assessInstallHealth,
  needsReconciliation,
  type ChatInstallHealth,
} from "../services/shopify-chat-install.service";

const TENANT = "t1";

function install(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    shopDomain: "my-store.myshopify.com",
    status: "ACTIVE" as const,
    appIdentity: "gotcha-core",
    tenantId: TENANT,
    channelAccountId: "c1",
    verifiedDomains: ["my-store.myshopify.com"],
    installedAt: new Date(),
    uninstalledAt: null,
    boundAt: new Date(),
    lastHeartbeatAt: null,
    ...over,
  } as any;
}

describe("assessInstallHealth", () => {
  it("passes a correctly installed, bound, Core-owned row", () => {
    expect(assessInstallHealth(install(), TENANT)).toBe("ok");
    expect(needsReconciliation("ok")).toBe(false);
  });

  it("reports UNINSTALLED — the exact state that broke the storefront", () => {
    // Channel said enabled=true; installation said UNINSTALLED. This is the
    // disagreement, and it must be visible rather than silently healthy.
    const h = assessInstallHealth(install({ status: "UNINSTALLED", uninstalledAt: new Date() }), TENANT);
    expect(h).toBe("uninstalled");
    expect(needsReconciliation(h)).toBe(true);
  });

  it("reports a missing installation", () => {
    const h = assessInstallHealth(null, TENANT);
    expect(h).toBe("installation_missing");
    expect(needsReconciliation(h)).toBe(true);
  });

  it.each(["gotcha-chat", "gotcha-chat-dev"])(
    "reports the retired two-app identity %s as wrong",
    (legacy) => {
      // A row written before unification still serves, but belongs to an app
      // that no longer installs anything. It must be re-homed on next enable.
      const h = assessInstallHealth(install({ appIdentity: legacy }), TENANT);
      expect(h).toBe("wrong_app_identity");
      expect(needsReconciliation(h)).toBe(true);
    },
  );

  it("accepts the unified identity", () => {
    expect(assessInstallHealth(install({ appIdentity: "gotcha-core" }), TENANT)).toBe("ok");
  });

  it("reports an unbound installation", () => {
    const h = assessInstallHealth(install({ tenantId: null }), TENANT);
    expect(h).toBe("tenant_binding_missing");
    expect(needsReconciliation(h)).toBe(true);
  });

  it("refuses another organization's installation — tenant isolation", () => {
    // Must never resolve as healthy for a tenant that does not own it.
    const h = assessInstallHealth(install({ tenantId: "other-tenant" }), TENANT);
    expect(h).toBe("tenant_binding_missing");
    expect(needsReconciliation(h)).toBe(true);
  });

  it("checks UNINSTALLED before identity, so the actionable reason wins", () => {
    // A retired row with a legacy identity is both. "uninstalled" is the one
    // the merchant can act on, so it must be what surfaces.
    expect(
      assessInstallHealth(install({ status: "UNINSTALLED", appIdentity: "gotcha-chat-dev" }), TENANT),
    ).toBe("uninstalled");
  });

  it("treats every non-ok state as requiring reconciliation", () => {
    const degraded: ChatInstallHealth[] = [
      "installation_missing",
      "uninstalled",
      "wrong_app_identity",
      "tenant_binding_missing",
    ];
    for (const h of degraded) {
      expect(needsReconciliation(h), `${h} must require repair`).toBe(true);
    }
  });
});

describe("the channel flag is never proof on its own", () => {
  it("an enabled channel does not make a retired installation healthy", () => {
    // The whole bug in one assertion: whatever the channel says, a retired
    // installation cannot serve the storefront.
    const chatEnabled = true;
    const health = assessInstallHealth(install({ status: "UNINSTALLED" }), TENANT);
    const uiWouldShowHealthy = chatEnabled && !needsReconciliation(health);
    expect(uiWouldShowHealthy).toBe(false);
  });

  it("a disabled channel with a healthy installation is merely off, not broken", () => {
    const health = assessInstallHealth(install(), TENANT);
    expect(needsReconciliation(health)).toBe(false);
  });
});
