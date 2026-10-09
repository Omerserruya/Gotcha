import type { SkillCategory } from '@/api/contracts/skills';

import { sessionRejected } from '@/api/client/session-rejected';
import { SessionEnded } from '@/api/client/SessionEnded';
import { loadSkillEmployees, loadSkillsLibrary } from './load-skills';
import { NewSkill } from './NewSkill';
import { SkillsLibrary } from './SkillsLibrary';

/** 09's data: the library, and - with 21 open - who it can be given to. */
export async function LibrarySection({
  category,
  creating,
}: {
  readonly category: SkillCategory | null;
  readonly creating: boolean;
}) {
  const [{ skills, tools }, employees] = await Promise.all([
    loadSkillsLibrary(),
    creating ? loadSkillEmployees() : Promise.resolve(null),
  ]);
  // The platform refused the session during this render: sign-in, not "couldn't read".
  if (sessionRejected()) return <SessionEnded />;
  return (
    <>
      <SkillsLibrary skills={skills} tools={tools} category={category} />
      {creating ? (
        <NewSkill
          employees={employees}
          tools={tools ? [...tools.values()] : null}
          otherSkills={(skills ?? [])
            .filter((s) => s.status !== 'archived')
            .map((s) => ({ id: s.id, name: s.name }))}
        />
      ) : null}
    </>
  );
}
