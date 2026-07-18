# Disaster Recovery Drill - GOTCHA + Authentik

> **Executed:** 2026-07-17 · **Result: PASS.** Both databases restored into an isolated environment and a real login was verified against the restored Authentik.
> **Scope:** the two stateful databases that hold irreplaceable data - the GOTCHA business DB (`whatsapp_cc`) and the Authentik identity DB (`authentik`). Redis (queues/cache) and Qdrant (re-embeddable) are recoverable by replay/rebuild and are out of scope.

This is the drill the prior audits kept flagging as missing: *"an untested backup is a hypothesis."* It is now tested.

---

## 1. Why both databases, and why this is the real test

After the Authentik migration, a working login depends on **two** databases agreeing:

- Authentik (`authentik` DB) holds the identity, the credential, and - critically - the **RS256 signing keypair** whose public half is served at JWKS. Every GOTCHA service verifies tokens against that key.
- GOTCHA (`whatsapp_cc` DB) holds `User.authentikSubject`, the immutable join from an Authentik identity to a GOTCHA account, plus all tenant/role/business data.

The failure mode this drill exists to catch: *we have backups, but after a restore nobody can log in* - because the signing key didn't survive, or the subject↔account join broke. Restoring one DB proves nothing; the guarantee is that a **paired** restore preserves the end-to-end login.

## 2. Procedure (reproducible)

The dumps use the exact commands the nightly cron runs (`terraform/user_data.sh`):

```bash
# 1. Dump both DBs (identical to the nightly cron).
docker compose exec -T db            pg_dump -U postgres  whatsapp_cc | gzip > gotcha.sql.gz
docker compose exec -T authentik-db  pg_dump -U authentik authentik   | gzip > authentik.sql.gz

# 2. Stand up a FULLY ISOLATED environment: own compose project (gotchadr),
#    own network, own volumes, distinct host ports. Nothing shared with prod.
docker compose -p gotchadr -f docker-compose.dr.yml up -d dr-gotcha-db dr-authentik-db dr-redis

# 3. Restore both dumps into the fresh databases.
zcat gotcha.sql.gz    | docker exec -i gotchadr-dr-gotcha-db-1    psql -U postgres  -d whatsapp_cc -q
zcat authentik.sql.gz | docker exec -i gotchadr-dr-authentik-db-1 psql -U authentik -d authentik   -q

# 4. Boot a restored Authentik against the restored identity DB.
#    AUTHENTIK_SECRET_KEY MUST equal the source key (see finding DR-1).
docker compose -p gotchadr -f docker-compose.dr.yml up -d dr-authentik-server

# 5. Drive a real end-to-end login against the RESTORED instance.
AUTHENTIK_URL_PUBLIC=http://localhost:9100 \
  node scripts/authentik/e2e-oidc-check.mjs <email> <password>

# 6. Tear down, including volumes.
docker compose -p gotchadr -f docker-compose.dr.yml down -v
```

The isolated compose file used for the drill is preserved at
`docs/operations/dr/docker-compose.dr.yml`.

## 3. Results (measured)

| Check | Baseline (live) | Restored | Verdict |
|---|---|---|---|
| GOTCHA dump | - | 1.5 MB, valid gzip, 32,530 lines | OK |
| Authentik dump | - | 1.1 MB, valid gzip, 23,434 lines | OK |
| GOTCHA restore errors | - | **0** | OK |
| Authentik restore errors | - | **0** | OK |
| GOTCHA users \| linked to Authentik | `8 \| 8` | `8 \| 8` | **match** |
| Sample link (`admin@demo.com`) | `→ 32d73794…4b4d` | `→ 32d73794…4b4d` | **match** |
| Authentik `core_user` count | `11` | `11` | **match** |
| **Authentik JWKS signing key `kid`** | `3e50ade9…1ab39f` | `3e50ade9…1ab39f` | **SAME KEY** |
| Real PKCE login vs restored Authentik | - | steps 1–8 pass; token verified via JWKS; forged sig + `alg=none` rejected | **PASS** |
| Cross-DB identity join (`admin@demo.com` subject exists as a real restored Authentik user) | - | `admin@demo.com (32d73794…4b4d)` | **join intact** |

The single most important line: the restored Authentik returned the **same signing key**, and a real login against it produced a token that verifies exactly as production would. The login→account join survives a full paired restore.

## 4. Findings

### DR-1 [must-know] The Authentik secret key is part of the backup set
`AUTHENTIK_SECRET_KEY` encrypts the signing keypair at rest inside the `authentik` DB. Restore the DB with a *different* secret key and the certs are undecryptable - the restored IdP cannot sign, and no one can log in, even though the dump restored "successfully." **The secret key must be stored with the backups** (in the secrets manager, not only in a running container's env). A DB backup alone is not sufficient to recover authentication.

### DR-2 [gap, now fixed] The Authentik DB was not in the nightly backup
Before this work, `terraform/user_data.sh` dumped only the GOTCHA DB. A disk loss would have restored all business data and **permanently locked every user out** - the surviving GOTCHA rows point via `authentikSubject` at identities that no longer exist. The nightly script now dumps `authentik-db` alongside GOTCHA (to `s3://<bucket>/authentik/`). This drill validates that dump restores and authenticates.

### DR-3 [risk] Backups are not restore-tested on a schedule, and S3 versioning is off
This drill is the first restore test. S3 lifecycle expires backups at 90 days and versioning is off (`terraform/s3.tf`), so a corrupt overwrite is unrecoverable. Recommendation: run this drill quarterly and record the date; consider enabling S3 versioning on the backups bucket.

## 5. Observed recovery characteristics

- **RTO (this drill, single box):** databases restored and a login verified in well under an hour of wall-clock; the dominant cost is Authentik's ~60–90s boot/health. For a real incident, add image pull + DNS/tunnel bring-up.
- **RPO:** the nightly dump cadence (cron 02:30 UTC) sets worst-case data loss at ~24h. EBS DLM snapshots (daily) are a second, coarser tier.
- These are **observed** figures from the drill, not a formal SLA. A stated RTO/RPO target belongs in a BCP document (tracked in the readiness checklist).
