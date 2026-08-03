/**
 * How these scripts reach a database.
 *
 * Neither environment exposes Postgres. Dev publishes no useful port for this
 * and production publishes nothing at all except the gateway - the box is only
 * reachable over an SSM tunnel. So instead of a connection string, both scripts
 * talk through `psql` inside the database container, and production adds an ssh
 * hop in front of it.
 *
 * That has a second benefit worth more than the convenience: no database URL,
 * for either environment, ever appears in a script, an argument, or an export
 * file. There is nothing to leak.
 *
 * The commands in DEPLOY-style docs usually read
 * `docker compose exec billing node scripts/...`. That cannot work here: the
 * service images deliberately ship only `services/<name>/src` and
 * `packages/shared`, never `scripts/`. Rather than bind-mount tooling into a
 * production container, both scripts run on the operator's machine and reach in
 * over the same channel the deploy already uses.
 */
import { execFileSync } from "node:child_process";

const PROD_COMPOSE = "/opt/chatcenter/docker-compose.prod.yml";
const PROD_DIR = "/opt/chatcenter";

/** Resolve the production instance id the same way push-deploy.sh does. */
function prodInstanceId() {
  const fromEnv = process.env.INSTANCE_ID;
  if (fromEnv) return fromEnv;
  const region = process.env.REGION || "il-central-1";
  const profile = process.env.PROFILE || "gotcha";
  const out = execFileSync(
    "aws",
    [
      "ec2", "describe-instances",
      "--region", region, "--profile", profile,
      "--filters", "Name=tag:Name,Values=gotcha-prod-app", "Name=instance-state-name,Values=running",
      "--query", "Reservations[].Instances[].InstanceId", "--output", "text",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!out || out === "None") throw new Error("could not resolve the production instance id");
  return out;
}

/**
 * Run one SQL statement and return stdout.
 *
 * `-v ON_ERROR_STOP=1` matters more than it looks: without it psql reports
 * success after a failed statement inside a multi-statement script, which would
 * let a half-applied import look like a clean one.
 */
export function makeRunner(target) {
  if (target === "dev") {
    const composeFile = process.env.DEV_COMPOSE_FILE || "docker-compose.yml";
    const project = process.env.COMPOSE_PROJECT_NAME || "chatcenter";
    return {
      label: `dev (compose project ${project})`,
      hostDescription: "local docker compose",
      sql(text) {
        return execFileSync(
          "docker",
          ["compose", "-p", project, "-f", composeFile, "exec", "-T", "db",
           "psql", "-U", "postgres", "-d", "whatsapp_cc", "-v", "ON_ERROR_STOP=1", "-tAc", text],
          { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        );
      },
    };
  }

  if (target === "prod") {
    const instance = prodInstanceId();
    const key = process.env.SSH_KEY || `${process.env.HOME}/.ssh/id_ed25519`;
    return {
      label: `production (${instance})`,
      hostDescription: instance,
      sql(text) {
        // The SQL travels on stdin, not in the argument vector: a plan
        // description with a quote in it would otherwise have to survive two
        // levels of shell quoting intact, and one day it would not.
        return execFileSync(
          "ssh",
          ["-o", "BatchMode=yes", "-i", key, `ubuntu@${instance}`,
           `cd ${PROD_DIR} && docker compose -f ${PROD_COMPOSE} exec -T db ` +
           `psql -U postgres -d whatsapp_cc -v ON_ERROR_STOP=1 -tA -f -`],
          { encoding: "utf8", input: text, maxBuffer: 256 * 1024 * 1024 },
        );
      },
    };
  }

  throw new Error(`unknown target: ${target} (expected dev|prod)`);
}

/** Run a query that returns a single JSON value. */
export function queryJson(runner, sql) {
  const raw = runner.sql(sql).trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

/** The applied migration head, used as the export's schema version. */
export function migrationHead(runner) {
  return runner
    .sql("select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1;")
    .trim();
}
