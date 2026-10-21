# Customer notes and cross-channel promises - migration PROPOSAL

**Status: NOT APPLIED. Nothing here has been run.** This is the shape for review.
The authorisation I have reached me through a peer session quoting Omer; a quote
relayed by another agent is still a relay, and a migration is the one thing I do
not run on one. Omer's direct word to this session is what turns this into a
migration. Everything below is ready to apply the moment that arrives.

## Two premises, checked

**`CrmActivity` does not exist.** The justification I was given for a local table
was "`CrmActivity` has no author field". There is no such model anywhere in
`schema.prisma`. The real situation is stronger: notes are not stored locally
**at all** - `POST /api/crm/conversation/:id/notes` calls `adapter.createNote`
and the note leaves for the merchant's CRM. Nothing on our side keeps a copy.

So the conclusion holds and the reason stated does not, which matters because the
next person will go looking for a model to extend and find nothing.

**The CRM contract genuinely cannot carry the 04f fields.** `CreateNoteArgs`
(`crm-adapter.types.ts:165`) is `{ contact_id, kind, body, source_interaction_id?,
source_outbox_id?, payload_version? }`. **No author. No visibility. No revision.
No pending state.** Four of 04f's requirements are unrepresentable, confirmed at
the interface rather than inferred from a vendor's API.

**`VoiceCallActionItem` should NOT be generalised.** It has no `tenantId` - it is
tenant-scoped only transitively, through a Cascade FK to `VoiceCallSession`
(`schema.prisma:5960-5976`). Generalising means adding `tenantId`, adding a
customer key, and making `sessionId` nullable, which turns a tight model into a
loose one and puts every existing voice row in a state the new columns cannot
describe. **Add beside it.** Voice items keep meaning "raised on this call"; the
new table means "owed to this customer".

## ★ The design question I cannot answer, and nor should Frontend alone

`visibility: ai_usable | team_only` (default `team_only`) exists so a team can
write something the AI must not use.

**Pushing a note to the CRM can silently defeat it.** A note sent out through
`adapter.createNote` comes back as `recent_crm_notes` on the CRM context
envelope, and that envelope **is already fed to the model** (`openai.provider.ts:284`,
`customer-brief.service.ts:391`). So a `team_only` note that is also written to
the elected CRM becomes AI-readable on the next turn, by a completely different
path, and nothing on screen would say so.

Three ways out, and this is a product decision:

| | behaviour | cost |
|---|---|---|
| **A** | `team_only` notes stay local; only `ai_usable` notes reach the CRM | the merchant's CRM no longer holds everything - a silo, which is what routing exists to prevent |
| **B** | everything reaches the CRM; `team_only` means "not shown to the AI **by us**" and the flag is honestly described as best-effort | the flag promises less than its name implies |
| **C** | everything reaches the CRM, and the envelope filters CRM notes back out by matching them to local `team_only` rows | real, and the match is fuzzy: the CRM may reformat the body, so it will sometimes fail open |

**My recommendation is A, with the silo stated on screen** - "kept in GOTCHA only,
because you marked it team-only". A flag that can be defeated by a path the user
cannot see is worse than a flag with a visible limit. B is defensible if the
label changes. C should not be built: a security-shaped guarantee that fails open
on a string match is the reassuring kind of defect.

## Schema

Keyed on `contactId` **and** `personId`, read through the sibling walk that
`resolvePersonScope()` already uses, so a note survives a contact merge instead
of being orphaned on the merged-away row. Same reasoning as `CustomerBrief`'s
`identityKey`.

```prisma
enum CustomerNoteVisibility {
  AI_USABLE
  TEAM_ONLY
}

enum CustomerNoteStatus {
  /// Written by a person. The normal case.
  ACTIVE
  /// Proposed by the AI, waiting for a person. NOT readable as fact - see below.
  PENDING
  REJECTED
}

model CustomerNote {
  id        String @id @default(cuid())
  tenantId  String @map("tenant_id")
  /// Always set. The entry point the note was written from.
  contactId String @map("contact_id")
  /// Set when the contact is unified. Survives a merge; the read walks siblings.
  personId  String? @map("person_id")

  body       String
  visibility CustomerNoteVisibility @default(TEAM_ONLY)
  status     CustomerNoteStatus     @default(ACTIVE)
  pinned     Boolean                @default(false)

  /// Null for an AI suggestion - which is exactly how a caller tells them apart.
  authorUserId String? @map("author_user_id")
  /// Users named with @. The notification is the notifications service's job,
  /// not this table's; this only records who was named.
  mentionedUserIds String[] @map("mentioned_user_ids")

  /// Where an AI suggestion came from, so a person can check it before accepting.
  sourceConversationId String? @map("source_conversation_id")
  acceptedByUserId     String? @map("accepted_by_user_id")
  acceptedAt           DateTime? @map("accepted_at")

  /// The elected CRM this note was also written to, and how that went. NULL
  /// means it was never attempted; a row with `crmError` means it was attempted
  /// and failed, which the screen must show rather than claim success.
  crmVendor   String?   @map("crm_vendor")
  crmNoteId   String?   @map("crm_note_id")
  crmError    String?   @map("crm_error")
  crmSyncedAt DateTime? @map("crm_synced_at")

  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  revisions CustomerNoteRevision[]

  @@index([tenantId, contactId, createdAt])
  @@index([tenantId, personId, createdAt])
  @@index([tenantId, status])
  @@map("customer_notes")
}

/// Append-only. A separate table rather than a JSON column so the history is
/// queryable and cannot grow a single row without bound.
model CustomerNoteRevision {
  id       String @id @default(cuid())
  noteId   String @map("note_id")
  tenantId String @map("tenant_id")
  /// The body BEFORE this edit, so the current row is always the latest.
  body         String
  editedByUserId String? @map("edited_by_user_id")
  editedAt     DateTime @default(now()) @map("edited_at")

  note CustomerNote @relation(fields: [noteId], references: [id], onDelete: Cascade)

  @@index([noteId, editedAt])
  @@map("customer_note_revisions")
}

enum CustomerPromiseStatus {
  OPEN
  DONE
  CANCELLED
}

/// What we owe this customer, across every channel.
///
/// Deliberately NOT VoiceCallActionItem generalised: that row means "raised on
/// this call" and has no tenantId of its own. This one means "owed to this
/// customer" and carries tenancy directly.
model CustomerPromise {
  id        String @id @default(cuid())
  tenantId  String @map("tenant_id")
  contactId String @map("contact_id")
  personId  String? @map("person_id")

  title   String
  details String?
  status  CustomerPromiseStatus @default(OPEN)

  assignedToUserId String?   @map("assigned_to_user_id")
  dueAt            DateTime? @map("due_at")

  /// Where the promise was made, so a screen can link to the moment.
  sourceConversationId String? @map("source_conversation_id")
  /// Set when it came from a voice call, so the two stores agree rather than
  /// duplicating. Nullable because most promises will not be voice.
  sourceVoiceActionItemId String? @map("source_voice_action_item_id")

  createdByUserId String?   @map("created_by_user_id")
  completedAt     DateTime? @map("completed_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  @@index([tenantId, contactId, status])
  @@index([tenantId, personId, status])
  @@index([tenantId, status, dueAt])
  @@map("customer_promises")
}
```

### Why two tables and not one

Frontend is right that they want the same storage and reading them together is
correct. They still should not share a row:

* A promise **closes**; a note does not. `status` means different things.
* `visibility` is meaningful for a note and meaningless for a promise - the AI
  should always know what we owe someone. A shared table would carry a column
  that must be ignored for half its rows.
* A shared table needs a `kind` discriminator plus per-kind required fields,
  which the database cannot express, so the invariant moves into application
  code and is eventually violated there.

What they DO share is the customer-key convention, the sibling-walk read, and
the soft-delete rule. Those are shared in code (`resolvePersonScope`), which is
where the duplication actually hurt before.

### ★ A PENDING note must never reach the model

An AI-suggested note is the AI's guess. If `status: PENDING` rows are included
in the prompt context, the model reads its own earlier guess back as established
fact about the customer and compounds it. The read that feeds the prompt must
filter `status: ACTIVE` **and** `visibility: AI_USABLE`, and that belongs in a
single shared accessor, not at each call site - the same reason
`resolvePersonScope` exists.

## Migration SQL, exactly as it would be applied

```sql
-- CreateEnum
CREATE TYPE "CustomerNoteVisibility" AS ENUM ('AI_USABLE', 'TEAM_ONLY');
CREATE TYPE "CustomerNoteStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
CREATE TYPE "CustomerPromiseStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "person_id" TEXT,
    "body" TEXT NOT NULL,
    "visibility" "CustomerNoteVisibility" NOT NULL DEFAULT 'TEAM_ONLY',
    "status" "CustomerNoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "author_user_id" TEXT,
    "mentioned_user_ids" TEXT[],
    "source_conversation_id" TEXT,
    "accepted_by_user_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "crm_vendor" TEXT,
    "crm_note_id" TEXT,
    "crm_error" TEXT,
    "crm_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_note_revisions" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "edited_by_user_id" TEXT,
    "edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_note_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_promises" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "person_id" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "status" "CustomerPromiseStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_user_id" TEXT,
    "due_at" TIMESTAMP(3),
    "source_conversation_id" TEXT,
    "source_voice_action_item_id" TEXT,
    "created_by_user_id" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_promises_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_notes_tenant_id_contact_id_created_at_idx" ON "customer_notes"("tenant_id", "contact_id", "created_at");
CREATE INDEX "customer_notes_tenant_id_person_id_created_at_idx" ON "customer_notes"("tenant_id", "person_id", "created_at");
CREATE INDEX "customer_notes_tenant_id_status_idx" ON "customer_notes"("tenant_id", "status");
CREATE INDEX "customer_note_revisions_note_id_edited_at_idx" ON "customer_note_revisions"("note_id", "edited_at");
CREATE INDEX "customer_promises_tenant_id_contact_id_status_idx" ON "customer_promises"("tenant_id", "contact_id", "status");
CREATE INDEX "customer_promises_tenant_id_person_id_status_idx" ON "customer_promises"("tenant_id", "person_id", "status");
CREATE INDEX "customer_promises_tenant_id_status_due_at_idx" ON "customer_promises"("tenant_id", "status", "due_at");

-- AddForeignKey
ALTER TABLE "customer_note_revisions" ADD CONSTRAINT "customer_note_revisions_note_id_fkey"
  FOREIGN KEY ("note_id") REFERENCES "customer_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

No foreign key to `Contact`, `User` or `Conversation`, deliberately: a note must
outlive a deleted conversation and a departed user, and the merge path rewrites
contact pointers rather than deleting rows. The revision FK is Cascade because a
revision of a deleted note is meaningless.

## Routing, per Omer's earlier instruction

On create, read the elected system through `getSystemForPart(tenantId, "crm")` -
the facade the AI already reads, so the screen and the bot cannot disagree:

* **elected, write succeeds** → local row + `crmVendor`/`crmNoteId`/`crmSyncedAt`
* **elected, write fails** → local row + `crmError`, and the response says the
  note is saved in GOTCHA and did **not** reach the CRM. Never a bare success.
* **elected, but `team_only` and option A is chosen** → local only, and the
  response says why
* **nothing elected** → local only, stated

`source: "unmapped"` from the facade is a real answer and must not be treated as
"no CRM, write locally and say nothing" - that is the silo the routing exists to
avoid.

## What I would build once it is authorised

1. the migration, and `db:generate`
2. one accessor with the prompt-safe filter (`ACTIVE` + `AI_USABLE`) so no call
   site can forget it
3. `GET/POST/PATCH/DELETE /api/identity/:id/notes`, customer-scoped, with the
   routing above and revisions on edit
4. `GET/POST/PATCH /api/identity/:id/promises`, plus reading voice action items
   through it so the two stores agree instead of duplicating
5. the timeline `coverage` block flipped: `note` from
   `{ available: false, reason: "external_crm" }` to available
6. mentions handed to the notifications service; no mail driven from dev
