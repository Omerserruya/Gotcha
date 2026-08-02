import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plan editor against the API it calls.
 *
 * This screen did not exist. The backend accepted the edits, the API client had
 * the functions, and the list page told whoever created a draft to "edit it,
 * preview, then publish" - with nowhere to do so. A draft could only ever be
 * published exactly as seeded.
 *
 * The tests are about the seam between the two halves, because that is what
 * broke last time: the rate-override form went on posting `{ rate }` after the
 * server began requiring a reason, and every override failed with a fully green
 * suite. Nothing checked the caller against the callee.
 */
const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const editor = read("app/system/plans/[id]/page.tsx");
const list = read("app/system/plans/page.tsx");
const client = read("lib/api-pricing-admin.ts");
const code = editor.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the editor is reachable", () => {
  it("a draft row links to it", () => {
    // The gap someone actually hit: a draft with no way in.
    expect(list).toContain("/system/plans/${p.id}");
    expect(list).toContain(">\n                      Edit\n                    </Link>");
  });

  it("only drafts offer it", () => {
    // Published versions are immutable; offering Edit would be a promise the
    // server answers with 409.
    const draftBranch = list.slice(list.indexOf('p.status === "DRAFT"'), list.indexOf('p.status === "ACTIVE"'));
    expect(draftBranch).toContain("Edit");
  });
});

describe("it calls what the server actually accepts", () => {
  it("uses the three edit endpoints, not hand-built fetches", () => {
    for (const fn of ["updateDraftPlan", "setPlanEntitlements", "setPlanVolumeOptions"]) {
      expect(code, `${fn} must be used`).toContain(fn);
      // Those functions existed and were called from nowhere.
      expect(client).toContain(`export const ${fn}`);
    }
    expect(code).not.toContain('fetch("/api/admin/pricing');
  });

  it("sends only fields PATCH /plans/:id reads", () => {
    // Anything else is silently dropped by the server, which looks like the
    // edit failing to save with no error at all.
    const accepted = [
      "name", "nameHe", "descriptionEn", "descriptionHe", "basePrice", "currency",
      "includedCredits", "voiceCredits", "sortOrder", "supportLevel", "autoPurchaseEligible",
      "creditPackagesEligible", "chatVolumeEnabled", "voiceVolumeEnabled", "internalNote",
    ];
    const call = code.slice(code.indexOf("updateDraftPlan(token, plan.id, {"));
    const body = call.slice(0, call.indexOf("});"));
    const sent = (body.match(/^\s{8}(\w+):/gm) ?? []).map((l) => l.trim().replace(":", ""));
    const unknown = sent.filter((f) => !accepted.includes(f));
    expect(unknown, `not accepted by the server: ${unknown.join(", ")}`).toEqual([]);
  });

  it("sends entitlements with the key/valueType/value shape the server reads", () => {
    expect(code).toContain("key: f.key");
    expect(code).toContain("valueType: f.entitlementType");
    expect(code).toContain("value: entitlements[f.key]");
  });
});

describe("it cannot offer what the product cannot sell", () => {
  it("disables features that are not built", () => {
    // The server answers 422 feature_not_implemented. Being told after typing
    // is the difference between a UI and a trap.
    expect(code).toContain("const unbuilt = !feature.implemented");
    expect(code).toContain("disabled={unbuilt}");
    expect(editor).toContain("Not built yet - cannot be sold");
  });

  it("refuses to edit a published version, and says why", () => {
    expect(code).toContain('plan.status !== "DRAFT"');
    expect(editor).toContain("hold a commercial snapshot");
  });
});

describe("nothing is saved by accident", () => {
  it("does not auto-save", () => {
    // A half-finished price on a draft someone else publishes is the accident
    // worth preventing.
    expect(code).not.toMatch(/useEffect\([^)]*updateDraftPlan/);
    expect(editor).toContain("Save draft");
  });

  it("saves before previewing", () => {
    // Preview reads what is STORED. Previewing an unsaved edit would show, and
    // then publish, a plan nobody had.
    const fn = code.slice(code.indexOf("async function saveAndPreview"));
    expect(fn.indexOf("await save()")).toBeLessThan(fn.indexOf("previewPublish"));
  });

  it("will not write invalid JSON into an entitlement", () => {
    expect(code).toContain("setBad(true)");
    expect(editor).toContain("Not valid JSON - not saved");
  });
});

describe("the money is shown as its effect", () => {
  it("derives a per-credit figure", () => {
    // "$499" and "2,000 credits" mean little apart. The rate is the judgeable
    // number, and it is what a customer effectively pays.
    expect(code).toContain("price / credits");
    expect(editor).toContain("per credit");
  });

  it("states how many organizations are already on the published version", () => {
    expect(editor).toContain("subscriberCount");
    expect(editor).toContain("keep their snapshot");
  });
});

describe("the credit allowance is one number", () => {
  /**
   * `config:credit_split` is what quoteFor() actually sells, and it was seeded
   * once and cloned into every version. The editor wrote only the total, so a
   * plan edited to 10,000 credits went on granting the seeded 2,000. The editor
   * now sets the voice share of that total and the server derives the rest.
   */
  it("sets the voice share rather than a second independent number", () => {
    expect(editor).toContain("Of which voice credits");
    expect(code).toContain("voiceCredits: Math.min(");
  });

  it("shows what the split comes out as", () => {
    expect(code).toContain("const chatCredits = total - voiceCredits");
    expect(editor).toContain("chat ·");
  });

  it("cannot save a voice share larger than the allowance", () => {
    expect(editor).toContain("Voice credits cannot exceed the included credits");
  });
});

describe("the recommended plan can be set", () => {
  it("offers the badge on published public plans", () => {
    // The endpoint and the API client both existed; nothing ever called them,
    // so the badge could only be changed by editing the database.
    expect(client).toContain("export const setRecommendedPlan");
    expect(list).toContain("onSetRecommended");
    const activeBranch = list.slice(list.indexOf('p.status === "ACTIVE" ? ('));
    expect(activeBranch.slice(0, 1200)).toContain("Recommend");
  });

  it("toggles off, because null is how the recommendation is cleared", () => {
    expect(list).toContain("onSetRecommended(p.recommended ? null : p.key)");
  });
});

describe("versions do not pile up in one list", () => {
  it("filters to what is live, in progress, or superseded", () => {
    for (const scope of ["live", "drafts", "history"]) expect(list).toContain(`"${scope}"`);
    expect(list).toContain("const visible = plans.filter(");
  });

  it("defaults to what customers can actually buy", () => {
    expect(list).toContain('useState<PlanScope>("live")');
  });

  it("says how many versions the filter is hiding", () => {
    expect(list).toContain("other version");
  });
});

describe("discarding a draft", () => {
  it("is offered on drafts only", () => {
    const draftBranch = list.slice(list.indexOf('p.status === "DRAFT"'), list.indexOf('p.status === "ACTIVE"'));
    expect(draftBranch).toContain("Discard");
    // A published version defines what paying organizations agreed to.
    const activeBranch = list.slice(list.indexOf('p.status === "ACTIVE"'));
    expect(activeBranch.slice(0, 600)).not.toContain("Discard");
  });

  it("confirms, naming which draft", () => {
    expect(list).toContain("Discard draft ${key} v${version}?");
  });

  it("explains the refusal rather than showing a raw code", () => {
    expect(list).toContain("Only a draft can be discarded");
  });
});

describe("credit packages are editable", () => {
  it("can be added, edited and removed", () => {
    expect(list).toContain("savePackage(token, key, {");
    expect(list).toContain("deletePackage(token, p.key)");
    expect(list).toContain("New package");
  });

  it("will not let the key be changed after creation", () => {
    // Purchases reference the key. Renaming it orphans that history.
    expect(list).toContain('disabled={editing !== "__new__"}');
  });

  it("explains why a removal was refused", () => {
    // Both refusals are protective, and neither is obvious from a failed
    // request: a broken auto top-up surfaces weeks later, and a deleted
    // package takes the explanation of a real charge with it.
    expect(list).toContain("automatic top-up pointing at this package");
    expect(list).toContain("explains real charges");
  });
});

describe("POC and trial plans can be created", () => {
  it("offers the kinds that are time-boxed", () => {
    expect(list).toContain('value="POC"');
    expect(list).toContain('value="TRIAL"');
    expect(list).toContain('value="PUBLIC"');
  });

  it("does not offer CUSTOM here", () => {
    // A custom plan belongs to a tenant and has its own endpoint requiring one.
    const form = list.slice(list.indexOf("New plan"), list.indexOf("Create draft"));
    expect(form).not.toContain('value="CUSTOM"');
  });

  it("creates them as drafts", () => {
    expect(list).toContain("created as a draft");
  });
});
