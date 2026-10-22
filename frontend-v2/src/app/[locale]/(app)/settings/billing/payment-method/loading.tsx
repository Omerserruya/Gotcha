import { RouteLoading } from '@/shell/RouteLoading';

/** Shown the moment a navigation here starts: this route's title, its content as placeholders. */
export default function Loading() {
  return <RouteLoading label="settings.billing" preset="rows" />;
}
