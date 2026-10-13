import { describe, expect, it } from 'vitest';

import {
  aloneRate,
  canPause,
  canResume,
  employeeSchema,
  readinessRunStatusSchema,
  EMPLOYEE_STATUSES,
  type Employee,
} from './employees';

/** The rulings on screen 07, as assertions. */

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'a1',
  name: 'Sales',
  role: 'sales',
  status: 'ACTIVE',
  departmentName: null,
  knowledgeSources: [],
  lastTestedAt: null,
  openConversations: 3,
  handledConversations: 40,
  resolvedAlone: 31,
  tone: '',
  languages: {},
  escalationRules: [],
  identity: null,
  goal: null,
  persona: null,
  departmentId: null,
  createdAt: null,
  updatedAt: null,
  readinessReport: null,
  ...over,
});

describe('there is no fourth verb', () => {
  it('has exactly three statuses', () => {
    // The design says "Hire, edit, pause, fire". AIAgentStatus is
    // ACTIVE | DRAFT | PAUSED - firing is not a state this platform has.
    expect([...EMPLOYEE_STATUSES]).toEqual(['ACTIVE', 'DRAFT', 'PAUSED']);
  });

  it('refuses to parse a retired status into something plausible', () => {
    // `.catch('DRAFT')` must not quietly turn an invented lifecycle into a
    // real-looking one; the point is that the value cannot exist.
    expect(EMPLOYEE_STATUSES).not.toContain('RETIRED');
  });
});

describe('pause and resume are the only transitions', () => {
  it('offers pause on a working employee and resume on a paused one', () => {
    expect(canPause(employee({ status: 'ACTIVE' }))).toBe(true);
    expect(canResume(employee({ status: 'PAUSED' }))).toBe(true);
  });

  it('never offers both at once', () => {
    for (const status of EMPLOYEE_STATUSES) {
      const e = employee({ status });
      expect(canPause(e) && canResume(e), status).toBe(false);
    }
  });

  it('offers neither on a draft, which has never started', () => {
    expect(canPause(employee({ status: 'DRAFT' }))).toBe(false);
    expect(canResume(employee({ status: 'DRAFT' }))).toBe(false);
  });
});

describe('aloneRate - never handled and never succeeded are different', () => {
  it('is the share finished without a person stepping in', () => {
    expect(aloneRate(employee({ handledConversations: 40, resolvedAlone: 31 }))).toBeCloseTo(0.775);
  });

  it('is null rather than zero when nothing has been routed here', () => {
    // 0% would say it needed help every time. "Nothing routed here yet" is
    // the opposite fact and the screen renders it as words.
    expect(aloneRate(employee({ handledConversations: 0, resolvedAlone: 0 }))).toBeNull();
  });

  it('is a real zero when it handled work and finished none alone', () => {
    expect(aloneRate(employee({ handledConversations: 12, resolvedAlone: 0 }))).toBe(0);
  });
});

describe('an employee carries no field that could become a false claim', () => {
  it('exposes no escalation count and no rating', () => {
    /*
     * `isHandedOver` has six-plus writers sharing only "a person ended up
     * driving", and the CAUSE would need ConversationHandover.reason - which
     * holds zero rows while five conversations carry the flag. A cause column
     * would be a confident zero for every employee.
     */
    /*
     * `escalationRules` is exempt by name: it is the employee's CONFIGURED
     * handover triggers ("asks for a person"), not a count of handovers - a
     * setting someone wrote, which makes no claim about what happened.
     */
    const surface = Object.keys(employeeSchema.parse(employee())).filter(
      (k) => k !== 'escalationRules',
    );
    expect(surface.filter((k) => /escalat|rating|score|csat|coverage/i.test(k))).toEqual([]);
  });

  it('keeps openConversations, which includes WAITING', () => {
    // OPEN + WAITING, and WAITING is usually waiting on the CUSTOMER - so
    // nothing may caption this as live activity.
    expect(employeeSchema.parse(employee()).openConversations).toBe(3);
  });
});

describe('★ E1 - reachability keeps each channel’s accounts', () => {
  it('named, per field; absent stays absent', async () => {
    const { reachabilitySchema } = await import('./employees');
    const read = reachabilitySchema.parse({
      hasCanvas: true,
      reachable: true,
      channels: [
        {
          channel: 'WHATSAPP',
          reach: 'always',
          accounts: [{ channelAccountId: 'w1', displayName: 'שירות לקוחות', detail: 7 }],
        },
        { channel: 'INSTAGRAM', reach: 'sometimes' },
      ],
    });
    expect(read.channels![0]!.accounts).toEqual([
      { channelAccountId: 'w1', displayName: 'שירות לקוחות', detail: null },
    ]);
    expect(read.channels![1]!.accounts).toBeUndefined();
  });
});

describe('★★ H7 - the readiness report, read whole', () => {
  const read = (report: unknown) =>
    employeeSchema.parse({ ...employee(), readinessReport: report }).readinessReport;

  it('keeps the score, the totals and every question', () => {
    const report = read({
      score: 62,
      totals: { full: 3, partial: 1, none: 1, total: 5 },
      questions: [
        {
          question: 'Do you ship abroad?',
          coverage: 'none',
          reason: 'No shipping page',
          gapType: 'knowledge',
        },
        { question: 'Where is my order?', coverage: 'full', reason: '' },
      ],
      recommendations: [{ type: 'add_faq', title: 'Shipping', detail: 'Add it' }],
      generatedAt: '2026-10-13T10:00:00Z',
    });
    expect(report?.score).toBe(62);
    expect(report?.totals).toEqual({ full: 3, partial: 1, none: 1, total: 5 });
    expect(report?.questions).toEqual([
      { question: 'Do you ship abroad?', coverage: 'none', reason: 'No shipping page' },
      { question: 'Where is my order?', coverage: 'full', reason: '' },
    ]);
  });

  it('★ a malformed question drops alone - never the report, never the others', () => {
    const report = read({
      questions: [
        { question: 'Ok?', coverage: 'partial', reason: 'r' },
        { question: 'Bad coverage', coverage: 'maybe' },
        { question: '', coverage: 'none' },
        'not a row',
      ],
      recommendations: [{ type: 'other', title: 'T', detail: '' }],
    });
    expect(report?.questions.map((q) => q.question)).toEqual(['Ok?']);
    expect(report?.recommendations).toHaveLength(1);
  });

  it('a report from before the questions were read: none, and no score - not a zero', () => {
    const report = read({
      generatedAt: null,
      recommendations: [],
      score: 'high',
      totals: { full: 1 },
    });
    expect(report?.questions).toEqual([]);
    expect(report?.score).toBeNull();
    expect(report?.totals).toBeNull();
  });
});

describe('★★ H7 - the stored run status: absent, null and a value are three things', () => {
  const read = (data: unknown) => readinessRunStatusSchema.parse(data);

  it('a value is kept, with its time and its failure code', () => {
    expect(
      read({
        id: 'a1',
        readinessStatus: 'failed',
        readinessStartedAt: '2026-10-13T10:00:00Z',
        readinessFinishedAt: null,
        readinessError: 'timed_out',
      }),
    ).toEqual({
      readinessStatus: 'failed',
      readinessStartedAt: '2026-10-13T10:00:00Z',
      readinessFinishedAt: null,
      readinessError: 'timed_out',
    });
  });

  it('★ null (never recorded) stays null; absent (an older server) stays undefined', () => {
    expect(read({ readinessStatus: null }).readinessStatus).toBeNull();
    expect(read({ name: 'x' }).readinessStatus).toBeUndefined();
  });

  it('a state we do not know reads as an older server - never as running or done', () => {
    expect(read({ readinessStatus: 'queued' }).readinessStatus).toBeUndefined();
  });
});
