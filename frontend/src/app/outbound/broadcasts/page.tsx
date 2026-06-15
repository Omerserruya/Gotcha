import { redirect } from "next/navigation";

// The Broadcasts page has been rebranded to Campaigns. Old bookmarks and
// in-app links still land here - bounce them to the canonical URL so the
// experience is identical.
export default function BroadcastsRedirect() {
  redirect("/outbound/campaigns");
}
