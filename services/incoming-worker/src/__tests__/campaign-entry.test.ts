import { describe, it, expect } from "vitest";
import { campaignEntryMatches } from "../services/flow-executor.service";

/**
 * Which flow a paid lead lands in.
 *
 * Two directions of failure, and they are not symmetric: a paid lead routed to
 * the ordinary flow is a missed opportunity, while an ordinary lead routed
 * into a campaign flow is a conversation about an ad the customer never saw.
 * The second is worse, so every ambiguous case here resolves to "no match".
 */
const node = (data: Record<string, unknown>) => ({ id: "n1", type: "campaign_entry", data });

describe("any-campaign entry", () => {
  it("fires for a conversation that came from an ad", () => {
    expect(campaignEntryMatches(node({ scope: "any" }), { fromAdCampaign: true, referralSourceId: "120" })).toBe(true);
  });

  it("fires even when we know it was an ad but not WHICH ad", () => {
    // The status-webhook fallback: origin known, referral never arrived.
    expect(campaignEntryMatches(node({ scope: "any" }), { fromAdCampaign: true, referralSourceId: null })).toBe(true);
  });

  it("never fires for an ordinary conversation", () => {
    expect(campaignEntryMatches(node({ scope: "any" }), { fromAdCampaign: false, referralSourceId: null })).toBe(false);
    expect(campaignEntryMatches(node({ scope: "any" }), null)).toBe(false);
  });
});

describe("specific-ad entry", () => {
  const specific = node({ scope: "specific", sourceIds: ["120210000000000000", "120210000000000001"] });

  it("fires only for a listed ad", () => {
    expect(campaignEntryMatches(specific, { fromAdCampaign: true, referralSourceId: "120210000000000001" })).toBe(true);
    expect(campaignEntryMatches(specific, { fromAdCampaign: true, referralSourceId: "999" })).toBe(false);
  });

  it("tolerates ids copied by hand - spacing and case", () => {
    const messy = node({ scope: "specific", sourceIds: ["  120210000000000000 "] });
    expect(campaignEntryMatches(messy, { fromAdCampaign: true, referralSourceId: "120210000000000000" })).toBe(true);
  });

  // The important refusal: configured for one campaign but naming none must
  // NOT quietly become "every campaign".
  it("matches nothing when no ad id was given", () => {
    expect(campaignEntryMatches(node({ scope: "specific", sourceIds: [] }), { fromAdCampaign: true, referralSourceId: "120" })).toBe(false);
  });

  it("does not fire when the ad is unknown, even though it was an ad", () => {
    expect(campaignEntryMatches(specific, { fromAdCampaign: true, referralSourceId: null })).toBe(false);
  });
});
