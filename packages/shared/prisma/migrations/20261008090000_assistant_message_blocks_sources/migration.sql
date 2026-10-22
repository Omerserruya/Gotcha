-- Home chat stage 2 (docs/api/assistant-threads-v1.md §9): the cards the
-- server computed for an answer and the sources they came from. Additive with
-- defaults; existing messages read as []. Hand-written; identical to Prisma's
-- schema-to-schema diff.

ALTER TABLE "assistant_messages" ADD COLUMN     "blocks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sources" JSONB NOT NULL DEFAULT '[]';
