import { AutomationsPending } from '@/features/automations/AutomationsList';

import { AutomationsFrame } from './frame';

/** 09c the moment a navigation starts: its own frame and templates, the list as placeholders. */
export default function Loading() {
  return (
    <AutomationsFrame deleted={false}>
      <AutomationsPending />
    </AutomationsFrame>
  );
}
