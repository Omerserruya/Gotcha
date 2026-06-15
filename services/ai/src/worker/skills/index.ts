/**
 * System skills bootstrap.
 *
 * Importing this module side-effect-registers every system skill so the
 * registry is fully populated before any worker is composed.
 *
 * Phase 1 ships a representative subset (sales, support, hebrew speech,
 * tool-usage, pipeline transitions). Phase 5 cutover will add the
 * remaining skills extracted from `prompt-builder.service.ts` -
 * goals, decision-layer, playbook composition, execution contract,
 * tone-intensity, etc. - one per skill so the registry remains the
 * single source of truth.
 */

import "./operational/sales";
import "./operational/support";
import "./language/hebrew-natural-speech";
import "./execution/tool-usage-policy";
import "./execution/pipeline-transitions";

export {
  defineSkill,
  getSkill,
  listSkillMetadata,
  composeSkills,
  __clearRegistryForTests,
} from "./registry";
