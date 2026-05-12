-- Per-campaign override for the header media URL on IMAGE/VIDEO/DOCUMENT
-- WhatsApp templates. When NULL, the worker falls back to the template's
-- own example URL (message_templates.header_content).
ALTER TABLE "broadcasts" ADD COLUMN "header_media_url" TEXT;
