import { describe, expect, it } from 'vitest';

import { importListSchema, importStatusSchema } from './historical-import';

/**
 * ★★ The list the platform actually sends (services/ai historical-import.ts
 * toStatusView, at 601bfa88): `percent` and `analysisPercent` are null outside
 * their stage BY DESIGN. Prod, 2026-11-10: "Response did not match contract at:
 * imports.0.percent, imports.1.analysisPercent" - twelve times in fifteen
 * minutes, and the progress view showed nothing.
 */
const view = (over: Record<string, unknown>) => ({
  id: 'i1',
  source: 'whatsapp_coexistence',
  channelAccountId: 'ca1',
  status: 'SOURCE_SYNCING',
  stage: 'transferring',
  percent: 40,
  analysisPercent: null,
  analysisCounts: null,
  hasResults: false,
  importedMessages: 120,
  importedCustomers: 8,
  knowledgeCandidateCount: 0,
  knowledgeConflictCount: 0,
  failureReason: null,
  failedStage: null,
  startedAt: '2026-11-10T13:40:00.000Z',
  sourceCompletedAt: null,
  completedAt: null,
  sourceDeadlineAt: null,
  windowDays: 180,
  customersAnalyzed: 0,
  customersTotal: 0,
  conversationsExtracted: 0,
  conversationsEligible: 0,
  ...over,
});

describe('★★ null percentages are a stage, not a broken response', () => {
  it('a list with one import in each stage parses, nulls kept as null', () => {
    const parsed = importListSchema.parse({
      imports: [
        view({}),
        view({
          id: 'i2',
          status: 'ANALYZING',
          stage: 'analyzing',
          percent: null,
          analysisPercent: null,
        }),
        view({
          id: 'i3',
          status: 'ANALYZING',
          stage: 'analyzing',
          percent: null,
          analysisPercent: 55,
        }),
        view({
          id: 'i4',
          status: 'COMPLETED',
          stage: 'ready',
          percent: 100,
          analysisPercent: null,
        }),
        view({
          id: 'i5',
          status: 'FAILED',
          stage: 'failed',
          percent: null,
          analysisPercent: null,
          failedStage: 'analytics',
        }),
        view({
          id: 'i6',
          status: 'NOT_AVAILABLE',
          stage: 'unavailable',
          percent: null,
          analysisPercent: null,
        }),
      ],
    });
    expect(parsed.imports.map((i) => [i.id, i.percent, i.analysisPercent])).toEqual([
      ['i1', 40, null],
      ['i2', null, null],
      ['i3', null, 55],
      ['i4', 100, null],
      ['i5', null, null],
      ['i6', null, null],
    ]);
  });

  it('absent reads as null too, never as a made-up 0', () => {
    const parsed = importStatusSchema.parse({ id: 'i1', stage: 'analyzing' });
    expect(parsed.percent).toBeNull();
    expect(parsed.analysisPercent).toBeNull();
  });

  it('a null count reads as none counted, not as a failed parse', () => {
    const parsed = importStatusSchema.parse(
      view({ customersTotal: null, knowledgeCandidateCount: null }),
    );
    expect(parsed.customersTotal).toBe(0);
    expect(parsed.knowledgeCandidateCount).toBe(0);
  });
});
