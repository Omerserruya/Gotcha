# Google Drive as a Knowledge Source

How GOTCHA connects a Google Drive account to a knowledge base, what it asks Google for, and what has to be set by hand in the Google Cloud Console.

---

## 1. What the feature does

An admin connects one Google account per knowledge base and then picks **sources**. A source is one of:

| Pick | Behaviour |
|------|-----------|
| A single file | Imported, then re-checked on every sync and re-processed when it changes |
| Several files | Same, one source per file |
| A folder | Every supported file inside it, recursively, plus files added to it later |
| A folder in a Shared Drive | Identical, scoped to that Shared Drive |

A folder source is a standing subscription, not a one-time copy. Each sync answers three questions:

- what is new in there (import it)
- what changed in there (re-embed it)
- what is no longer in there (drop the knowledge derived from it)

---

## 2. OAuth scope

```
https://www.googleapis.com/auth/drive.readonly
```

That is the entire request. One scope, plus `access_type=offline`.

### Why `drive.readonly` and not `drive.file`

`drive.file` grants per-file access to exactly what the user picked in that one picker session. A folder source has to reach files that **do not exist yet**, so a per-file grant cannot back it: tomorrow's upload would be invisible, and the sync would quietly go stale instead of failing loudly. `drive.readonly` is the narrowest scope that can see a folder's future contents.

GOTCHA does **not** request `drive.file` in addition. Asking for both would add a permission that buys nothing.

### Read-only is enforced by the scope AND by the code

Every Drive call in `services/ai/src/services/google-drive.service.ts` is a `GET`. Nothing creates, updates, moves, shares or deletes anything in the user's Drive.

### What the disclosure must not claim

The consent copy shown before the redirect says the technical permission is read-only across the Drive, and that GOTCHA's own logic limits processing to the sources the user selected. It does **not** claim the scope itself is folder-limited, because that would be untrue.

### Consent prompt

`prompt=consent` is sent on a first connect and on an explicit reconnect only, because that is the only path on which Google returns a refresh token. A re-authorization of an already-connected account skips it, and the callback keeps the stored refresh token when Google omits one.

---

## 3. Manual steps in the Google Cloud Console

None of this is managed in code or IaC. It has to be set by hand.

**Google Auth Platform → Data Access → Scopes**

1. The Drive scope list must contain exactly `https://www.googleapis.com/auth/drive.readonly`.
2. Remove any other `drive.*` scope, in particular `drive.file` and `drive`.

**APIs & Services → Library**

3. **Google Drive API** must be enabled on the project.

**Credentials → OAuth 2.0 Client IDs**

4. The authorized redirect URI must match `GOOGLE_REDIRECT_URI` exactly, for each environment.

> `drive.readonly` is a **sensitive** scope (not restricted, unlike the Gmail scopes). An External-user-type app using it needs Google verification before it leaves Testing, including a demonstration video. See section 7.

---

## 4. Environment

| Variable | Used by | Meaning |
|----------|---------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `services/ai` | The OAuth client |
| `GOOGLE_REDIRECT_URI` | `services/ai` | `https://<host>/api/knowledge/oauth/google-drive/callback` |
| `CHANNEL_ENCRYPTION_KEY` | `services/ai` | Encrypts the stored tokens |
| `KNOWLEDGE_SYNC_CRON` | `services/ai` | Background tick, default hourly |

Optional safety limits, all with working defaults:

| Variable | Default | Meaning |
|----------|---------|---------|
| `DRIVE_MAX_FOLDER_DEPTH` | 10 | How deep a folder walk descends |
| `DRIVE_MAX_FILES_PER_SOURCE` | 500 | Files imported from one folder source |
| `DRIVE_MAX_FILE_BYTES` | 10MB | Per-file ceiling, matching the parser's own |
| `DRIVE_MAX_TOTAL_BYTES` | 200MB | Total bytes per folder source |
| `DRIVE_MAX_RETRIES` | 4 | Retries for 429/5xx |
| `DRIVE_RETRY_BASE_MS` | 500 | Backoff base |
| `DRIVE_SYNC_LOCK_TTL` | 900 | Seconds one integration's sync lock is held |

---

## 5. Supported file types

Google-native files are **exported** into a format the existing ingestion already reads. Binary files are downloaded and handed to the existing parser. No new parser was added.

| Type | Handling |
|------|----------|
| Google Docs | Export as `text/plain` |
| Google Sheets | Export as `text/csv` |
| Google Slides | Export as `text/plain` |
| PDF | Download, parse with `pdf-parse` |
| DOCX / DOC | Download, parse with `mammoth` |
| TXT / Markdown | Download, read as text |

Anything else is counted as unsupported and skipped. It is never silently dropped: a directly-selected unsupported file gets a "Partially synced" state with a reason.

---

## 6. How the sync works

**Polling, not the Changes API.** The Changes API tracks a whole Drive (or a whole Shared Drive) and hands back a change stream that then has to be filtered back down to the selected subtrees, with one page token per Drive per integration to store and repair. Walking the selected folders is a smaller amount of state for the same answer, and it degrades safely: a failed walk simply changes nothing. If the number of connected folders grows past what an hourly walk can carry, the Changes API is the next step.

Each tick, per non-paused source:

1. Read the source's metadata. Gone or invisible → **Action required**, and its documents are left alone.
2. Folder: walk it breadth-first, following `nextPageToken` to the end, with a visited set so multi-parented folders cannot loop.
3. Import each supported file. The change marker is `md5Checksum`, else `version`, else `modifiedTime`, so an unchanged file costs nothing.
4. **Only if the walk completed**, delete documents whose file is no longer in the listing.

Point 4 is the safety property. Deletion, trashing, a move out of the subtree, and a revoked share all look identical from Drive's side, and all four should drop the derived knowledge. A **truncated or failed** listing looks similar and must not, so silence is never read as deletion.

**Concurrency.** One sync per integration at a time, via a Redis lock. The hourly tick and a "Sync now" click cannot walk the same folder simultaneously; the loser is told to come back.

**Partial failure.** One unreadable file does not fail the folder, and one failed source does not stop the others. A revoked grant is the exception: everything else would fail identically, so the run stops and every source is marked Action required.

---

## 7. Recording the Google verification video

The reviewer has to see the OAuth consent screen, the granted scope in use, and the read-only claim being true. Record one continuous take:

1. **Show the app's identity.** Start on the GOTCHA sign-in page with the URL bar visible. The domain has to match the one on the OAuth consent screen.
2. **Show the privacy policy link** on the consent screen configuration, or navigate to `/legal/privacy-policy` and show the Google API Services User Data Policy / Limited Use section.
3. **Start the connect flow.** AI Studio → Knowledge → Connect Source → Google Drive. Pause on the GOTCHA disclosure dialog long enough to read it; this is where the read-only explanation appears.
4. **Show the Google consent screen** and read the requested permission aloud. Only one appears: see, edit, create and delete... no. `drive.readonly` renders as **"See and download all your Google Drive files"**. Do not skip past it; the reviewer needs the frame.
5. **Complete consent** and land back in GOTCHA.
6. **Justify the scope on camera.** Open the picker, tick a **folder**, and import it. Then, in Google Drive itself, add a new document to that folder. Return to GOTCHA, press **Sync now**, and show the new file appearing in the knowledge base. This is the whole argument for `drive.readonly` over `drive.file`, and it has to be shown, not asserted.
7. **Show the read-only claim holding.** Open the same folder in Google Drive and show that nothing was renamed, moved, or deleted, and that no new file was created by GOTCHA.
8. **Show deletion tracking.** Delete a file from the folder in Drive, press Sync now again, and show the corresponding document leaving the knowledge base.
9. **Show the user's control.** Demonstrate Pause, then Disconnect, showing the dialog that offers keeping or removing the imported knowledge.

Keep the take under about five minutes, keep the URL bar visible throughout, and use a test Google account with non-sensitive content: the video is reviewed by people outside your organization.

---

## 8. Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Sources stuck on "Action required" | The Google grant was revoked or the refresh token expired | Use the **Reconnect** button; it forces the consent screen, which is the only way to get a new refresh token |
| "A sync is already running" (409) | The hourly tick holds the lock | Wait; the lock TTL is `DRIVE_SYNC_LOCK_TTL` seconds |
| Folder shows "Partially synced" | A limit truncated the walk, or some files failed | Read the reason on the source row; raise the relevant `DRIVE_MAX_*` or split the folder |
| A file in the folder never appears | Its type is not in section 5 | Convert it to a supported format |
| Documents were not removed after deleting files in Drive | The last walk was truncated, so reconciliation was skipped by design | Fix the truncation first, then Sync now |
| `403` on a Shared Drive file | The connected Google account lost access to it | Re-share it with that account, or drop the source |
| Import and browse work but nothing refreshes | `autoSync` is off, or the source is paused | Check the Auto-sync toggle on the integration and Pause/Resume on the source |
