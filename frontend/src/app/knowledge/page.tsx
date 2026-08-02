import { redirect } from "next/navigation";

// One home per concept: knowledge lives inside the employee's workspace
// (AI Studio → Knowledge) and its full management page at
// /ai-studio/knowledge. This legacy standalone page duplicated both, so it
// now redirects instead of maintaining a third copy of the same surface.
export default function LegacyKnowledgePage() {
  redirect("/ai-studio/knowledge");
}
