"use client";

// "Your Business" is retired as a product area.
//
// The page showed a living profile assembled from the website scan - the
// business summary, products, policies, FAQs, brand voice, detected channels -
// plus a recommendation backlog and the workspace policy editor. The profile
// half was knowledge displayed in the wrong place: the AI employee retrieves
// from Knowledge Base chunks and could not read any of it, so a customer could
// read their own shipping policy on this page and still be told "I don't have
// that information" in a conversation.
//
// That material is now projected into real Knowledge Base entries at scan time
// (packages/shared/src/lib/knowledge), so this route redirects there. Old
// links and bookmarks keep working; nothing the scan learned is lost.
import { LegacyRedirect } from "@/components/LegacyRedirect";

export default function LegacyPage() {
  return <LegacyRedirect from="/settings/business" />;
}
