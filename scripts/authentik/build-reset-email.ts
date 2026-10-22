/**
 * Regenerate scripts/authentik/templates/gotcha_password_reset.html from
 * renderBrandEmail() (packages/shared/src/lib/email/reset-email-template.ts).
 *
 *   npx tsx scripts/authentik/build-reset-email.ts
 *
 * Run it after any change to brand-email.ts; the test
 * reset-email-template.test.ts fails while the committed file is stale.
 * Deploying the file: it is bind-mounted into authentik-server and
 * authentik-worker (both compose files), so copy it to the box and restart those two.
 */
import { writeFileSync } from "fs";
import path from "path";
import { buildResetEmailTemplate } from "../../packages/shared/src/lib/email/reset-email-template";

const out = path.resolve(__dirname, "templates/gotcha_password_reset.html");
writeFileSync(out, buildResetEmailTemplate());
console.log(`wrote ${out}`);
process.exit(0);
