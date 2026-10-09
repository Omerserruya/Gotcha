import { SkillsLibraryPending } from '@/features/skills/SkillsLibrary';

import { SkillsFrame } from './frame';

/** 09 the moment a navigation starts: its own frame, the library as placeholders. */
export default function Loading() {
  return (
    <SkillsFrame archived={false}>
      <SkillsLibraryPending />
    </SkillsFrame>
  );
}
