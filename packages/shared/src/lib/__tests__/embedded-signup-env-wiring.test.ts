/**
 * Every environment variable this code reads must actually reach the container.
 *
 * Both compose files map variables one at a time. That makes an UNLISTED
 * variable indistinguishable from an unset one: you set it in `.env`, nothing
 * changes, and there is no error anywhere to explain why.
 *
 * This has now bitten twice in production:
 *
 *   • the iCount capability switches, where absence read as `false` through a
 *     `${VAR:-false}` default and silently disabled charging;
 *   • `WHATSAPP_ES_FEATURE_TYPE`, which selects the WhatsApp Business app
 *     (Coexistence) onboarding flow. `buildEmbeddedSignupLaunch` had read it
 *     since the day it was written and no compose file passed it, so a customer
 *     whose number lives in the WhatsApp Business app had no way through and no
 *     way to find out why.
 *
 * So the rule is checked rather than remembered: if the builder reads it, both
 * compose files hand it to `auth`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const builder = readFileSync("src/whatsapp/embedded-signup.ts", "utf8");
const prod = readFileSync("../../docker-compose.prod.yml", "utf8");
const dev = readFileSync("../../docker-compose.yml", "utf8");

/** Every `env.SOMETHING` the launch builder actually reads. */
function envVarsRead(): string[] {
  const found = new Set<string>();
  for (const m of builder.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]);
  return [...found].sort();
}

describe("the launch builder's environment reaches the container", () => {
  it("reads the variables we think it reads", () => {
    // A canary: if this list changes, the wiring assertions below must be
    // re-read rather than silently covering a smaller surface.
    expect(envVarsRead()).toEqual([
      "META_APP_ID",
      "WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID",
      "WHATSAPP_ES_FEATURE_TYPE",
      "WHATSAPP_ES_SESSION_INFO_VERSION",
      "WHATSAPP_ES_VERSION",
    ]);
  });

  it("hands every one of them to auth in the production compose", () => {
    for (const key of envVarsRead()) {
      expect(prod, `${key} is read but never passed in docker-compose.prod.yml`)
        .toMatch(new RegExp(`^\\s+${key}:\\s*\\$\\{${key}`, "m"));
    }
  });

  it("hands every one of them to auth in the dev compose too", () => {
    // Dev diverging from prod here is worse than both being wrong: it makes the
    // bug unreproducible locally.
    for (const key of envVarsRead()) {
      expect(dev, `${key} is read but never passed in docker-compose.yml`)
        .toMatch(new RegExp(`^\\s+${key}:\\s*\\$\\{${key}`, "m"));
    }
  });
});

describe("the defaults are the safe ones", () => {
  it("leaves the launch knobs empty rather than inventing a value", () => {
    // Empty FEATURE_TYPE keeps the unified dialog for everyone. Empty VERSION
    // means v4, which sends an empty `extras`. A compose-level default here
    // would pin an experience nobody chose.
    for (const key of ["WHATSAPP_ES_VERSION", "WHATSAPP_ES_FEATURE_TYPE", "WHATSAPP_ES_SESSION_INFO_VERSION"]) {
      for (const [name, file] of [["prod", prod], ["dev", dev]] as const) {
        expect(file, `${key} must default to empty in the ${name} compose`)
          .toMatch(new RegExp(`${key}:\\s*\\$\\{${key}:-\\}`));
      }
    }
  });
});
