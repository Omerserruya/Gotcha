import {
  ONBOARDING_V2_STEPS,
  type JobStatus,
  type OnboardingV2Step,
} from '@/api/contracts/onboarding-v2';

/** What the server can show about this workspace's onboarding. */
export interface ResumeFacts {
  /** The step saved on Continue or Skip (TenantSetting "onboarding:step"); `null` when none. */
  readonly saved: OnboardingV2Step | null;
  /** The site job; `null` when none was ever started (404 NO_JOB). */
  readonly job: { readonly status: JobStatus } | null;
  readonly platformConnected: boolean;
  /** Nothing to suggest: the systems step has nothing to offer. */
  readonly noSuggestions: boolean;
  readonly channelConnected: boolean;
}

const at = (step: OnboardingV2Step) => ONBOARDING_V2_STEPS.indexOf(step);

/** The furthest step the server can PROVE: no job, website; a job, reading; a finished one, any. */
function furthest(job: ResumeFacts['job']): OnboardingV2Step {
  if (job === null) return 'website';
  return job.status === 'COMPLETE' ? 'live' : 'reading';
}

/** Where the server's own state points when nothing was saved. */
function derived(facts: ResumeFacts): OnboardingV2Step {
  if (facts.job === null) return 'website';
  if (facts.job.status !== 'COMPLETE') return 'reading';
  if (facts.channelConnected) return 'live';
  if (facts.platformConnected || facts.noSuggestions) return 'channels';
  return 'systems';
}

/**
 * The onboarding step to resume at (supervisor, 2026-10-23): the EXACT step
 * saved on Continue or Skip, unless it points past what the server can prove
 * (step=live with no finished read → reading). Missing, or past the proof:
 * the step derived from the server's own state.
 */
export function resumeAt(facts: ResumeFacts): OnboardingV2Step {
  if (facts.saved !== null && at(facts.saved) <= at(furthest(facts.job))) return facts.saved;
  return derived(facts);
}
