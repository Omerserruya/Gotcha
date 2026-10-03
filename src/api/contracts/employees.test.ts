import { describe, expect, it } from 'vitest';

import {
  aloneRate,
  canPause,
  canResume,
  employeeSchema,
  EMPLOYEE_STATUSES,
  type Employee,
} from './employees';

/** The rulings on screen 07, as assertions. */

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'a1',
  name: 'Sales',
  role: 'sales',
  status: 'ACTIVE',
  channels: ['whatsapp'],
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
  createdAt: null,
  updatedAt: null,
  readinessReport: null,
  ...over,
});

describe('there is no fourth verb', () => {
  it('has exactly three statuses', () => {
    // The design says "Hire, edit, pause, fire". AIAgentStatus is
    // ACTIVE | DRAFT | PAUSED — firing is not a state this platform has.
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

describe('aloneRate — never handled and never succeeded are different', () => {
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
     * driving", and the CAUSE would need ConversationHandover.reason — which
     * holds zero rows while five conversations carry the flag. A cause column
     * would be a confident zero for every employee.
     */
    /*
     * `escalationRules` is exempt by name: it is the employee's CONFIGURED
     * handover triggers ("asks for a person"), not a count of handovers — a
     * setting someone wrote, which makes no claim about what happened.
     */
    const surface = Object.keys(employeeSchema.parse(employee())).filter(
      (k) => k !== 'escalationRules',
    );
    expect(surface.filter((k) => /escalat|rating|score|csat|coverage/i.test(k))).toEqual([]);
  });

  it('keeps openConversations, which includes WAITING', () => {
    // OPEN + WAITING, and WAITING is usually waiting on the CUSTOMER — so
    // nothing may caption this as live activity.
    expect(employeeSchema.parse(employee()).openConversations).toBe(3);
  });
});
