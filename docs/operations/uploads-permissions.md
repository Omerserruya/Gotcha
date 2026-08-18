# Attachments are being lost: the uploads volume

## The symptom

An agent opens a conversation and sees "media unavailable" where a customer sent
a photo, a voice note or a document. The message text arrives normally. The
channel is healthy, the number is connected, and nothing in the webhook logs
looks wrong.

Confirmed in production on 2026-08-18, on WhatsApp, for every media type at
once. If it is only ONE type, this is not your problem.

## The cause

`/app/uploads` is a Docker **named volume**. Docker seeds a named volume from
the image's contents at that path, ownership included, but only when the image
actually contains that path. The images did not create it, so Docker created the
directory itself, `root:root` mode 755. The services run as `node` (uid 1000).

Every download therefore succeeded and every **write** failed:

```
fs.writeFileSync('/app/uploads/<uuid>.jpg')  ->  EACCES: permission denied
```

The media resolver caught that, returned `null`, and the message was stored with
`metadata.mediaError`. The agent was told the media was unavailable. Nothing
said "permission denied", and the log line blamed the download.

## Confirm it in thirty seconds

```bash
docker compose exec incoming-worker sh -c 'id; ls -ldn /app/uploads; touch /app/uploads/.probe && echo WRITABLE || echo NOT_WRITABLE'
```

`drwxr-xr-x 2 0 0` with `uid=1000` and `NOT_WRITABLE` is this bug exactly.

Since 2026-08-18 the services also say so themselves at boot:

```bash
docker compose logs incoming-worker | grep -i "CANNOT WRITE"
docker compose logs conversation  | grep -i "CANNOT WRITE"
```

## The fix

Two parts, and **the first one alone is not enough**.

### 1. The images now create the directory

`services/{incoming-worker,conversation,outgoing-worker}/Dockerfile` each carry:

```dockerfile
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
```

This fixes every **new** environment. Verified empirically: a fresh volume
mounted against the fixed image comes up `1000:1000` and writable.

### 2. Existing deployments need a one-time chown

Docker does **not** re-seed a volume that already holds files. A box that has
been running keeps the root-owned directory no matter how many times the image
is rebuilt and redeployed. Also verified empirically: the fixed image against a
non-empty root-owned volume is still `NOT_WRITABLE`.

So on each box, once:

```bash
docker compose run --rm --user root incoming-worker chown -R node:node /app/uploads
docker compose restart incoming-worker conversation outgoing-worker
```

Then re-run the confirmation command above. It must print `WRITABLE`.

## What cannot be recovered

Attachments that failed while this was broken are **gone**. WhatsApp deletes
media a short time after it is sent and the media id is the only handle on it,
so there is nothing to re-fetch. The affected messages keep their text and their
`mediaError` marker.

To see the blast radius for a tenant:

```sql
select date_trunc('day', created_at) as day,
       metadata->>'mediaError' as reason,
       count(*)
from messages
where tenant_id = '<TENANT>'
  and metadata->>'mediaError' is not null
group by 1, 2 order by 1 desc;
```

`storage_unwritable` rows are this bug. `download_failed` rows are Meta having
expired the media, which is a different and unavoidable thing.

## Why it stayed hidden

Three things had to line up, and all three were reasonable on their own:

* `fs.mkdirSync(dir, { recursive: true })` at boot **succeeds** against a
  directory that already exists. It says nothing about whether you may write to
  it, so the startup check that looked like a permission check was not one.
* The media resolver's `catch` returned `null` for every failure, so a
  permission error and an expired media id were indistinguishable downstream.
* The UI's "media unavailable" is a correct, calm message for an expired file,
  which is the common case. It was equally calm for a fixable outage.

All three are now addressed: the boot probe writes a real file and reports on
`media_storage_unwritable`, and the resolver classifies the failure before
recording it.
