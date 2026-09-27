import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { suggestionsResponseSchema } from '@/api/contracts/copilot';
import inbox from '@/i18n/messages/en/inbox.json';

import { CopilotPanel } from './CopilotPanel';
import type { CopilotRead } from './load-copilot';

/**
 * What GOTCHA would say, and the four ways it says nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE FOUR EMPTY STATES WANT THREE DIFFERENT ACTIONS FROM THE READER
 * ════════════════════════════════════════════════════════════════════════════
 * A single "no suggestions" would tell an agent the AI had no ideas, when the
 * truth may be that their plan does not include Copilot, or that the model call
 * failed. Write it yourself · ask someone who can change the plan · try again.
 *
 * And the refusal splits again, because `FEATURE_NOT_AVAILABLE` means the product
 * has not built the capability — no plan change lifts it.
 *
 * ⚠ NOTHING HERE IS A CONTROL. A `quick_action` suggestion carries a tool name and
 * arguments the model proposed, and firing a tool is what the approvals screen
 * exists for. There is nothing to press in this panel and no action to mock.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox.copilot') =>
    createTranslator({ locale: 'en', messages: { inbox }, namespace }),
}));

const ok = (over: Record<string, unknown> = {}): CopilotRead => ({
  state: 'ok',
  response: suggestionsResponseSchema.parse({ data: [], copilotMode: 'READY_MESSAGE', ...over }),
});

const refused = (
  code: string,
  upgradePath: string | null = '/settings/billing/plan',
): CopilotRead => ({
  state: 'refused',
  refusal: {
    code: code as 'PLAN_FEATURE_REQUIRED',
    feature: 'ai.copilot',
    currentPlan: 'foundation',
    upgradePath,
    limit: null,
    used: null,
  },
});

const show = async (read: CopilotRead) => render(await CopilotPanel({ read }));

describe('★★ the four ways this panel is empty', () => {
  it('★★ "nothing to suggest" tells the agent to write it themselves', async () => {
    await show(ok());
    expect(screen.getByTestId('copilot-empty')).toHaveTextContent(/write the reply yourself/i);
  });

  it('★★ "we could not reach GOTCHA" says nothing is wrong with the conversation', async () => {
    /*
     * The one state where trying again is the right move, and the one where an
     * agent might otherwise conclude the conversation itself is broken.
     */
    await show({ state: 'unavailable' });
    expect(screen.getByTestId('copilot-unavailable')).toHaveTextContent(
      /nothing is wrong with the conversation/i,
    );
  });

  it('★★ "not on your plan" points at who can change it', async () => {
    await show(refused('PLAN_FEATURE_REQUIRED'));
    expect(screen.getByTestId('copilot-refusal-reason')).toHaveTextContent(
      /not part of your plan/i,
    );
    expect(screen.getByTestId('copilot-upgrade')).toHaveTextContent(/admin role/i);
  });

  it('★★ "the product does not offer this" offers NO upgrade, because none exists', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * `FEATURE_NOT_AVAILABLE` IS NOT A COMMERCIAL STATE
     * ════════════════════════════════════════════════════════════════════════
     * `isEntitled` returns false for an unsellable key, which means the product
     * has not built the capability. Offering a plan change would sell somebody
     * something that does not exist — and it is the single most likely thing to
     * be collapsed into the code above by anyone tidying this up, so it is
     * asserted in both directions.
     */
    await show(refused('FEATURE_NOT_AVAILABLE'));
    expect(screen.getByTestId('copilot-refusal-reason')).toHaveTextContent(
      /not something a plan change would add/i,
    );
    expect(screen.queryByTestId('copilot-upgrade')).toBeNull();
  });

  it('★★ a limit breach is its own sentence', async () => {
    await show(refused('PLAN_LIMIT_REACHED'));
    expect(screen.getByTestId('copilot-refusal-reason')).toHaveTextContent(/used all/i);
  });

  it('★★ offers no link when the platform named no destination', async () => {
    /*
     * Inventing one would send somebody to a path that may not exist under this
     * app's base path — and the whole reason `upgradePath` reaches us at all is
     * that the envelope was stripping it.
     */
    await show(refused('PLAN_FEATURE_REQUIRED', null));
    expect(screen.queryByTestId('copilot-upgrade')).toBeNull();
  });

  it('★★ every state keeps the same heading', async () => {
    /*
     * A heading that appears and disappears as a plan or a model call changes
     * reads as a screen that failed to load. Asserted across all four.
     */
    for (const read of [
      ok(),
      { state: 'unavailable' } as CopilotRead,
      refused('PLAN_FEATURE_REQUIRED'),
      refused('FEATURE_NOT_AVAILABLE'),
    ]) {
      const { unmount } = await show(read);
      expect(screen.getByText('What GOTCHA would say')).toBeInTheDocument();
      unmount();
    }
  });
});

describe('★★ a mode we do not render says so', () => {
  it('★★ CHAT is a different panel, not a different list', async () => {
    /*
     * `CHAT` is a conversation between the agent and the AI with its own write
     * behind it. Rendering ready messages for it would show drafts the tenant's
     * configuration did not ask for.
     */
    await show(ok({ copilotMode: 'CHAT', data: [{ id: 's1', text: 'Hello', type: 'reply' }] }));
    expect(screen.getByTestId('copilot-other-mode')).toBeInTheDocument();
    expect(screen.queryByTestId('suggestion-s1')).toBeNull();
  });

  it('★★ an unrecognised mode is also not rendered as ready messages', async () => {
    /*
     * The reason `copilotMode` is a free string rather than `z.enum(...).catch()`:
     * a mode we have never seen must arrive as unrecognised, not be coerced into
     * the one we happen to render.
     */
    await show(ok({ copilotMode: 'SOMETHING_NEW', data: [{ id: 's1', text: 'Hi' }] }));
    expect(screen.getByTestId('copilot-other-mode')).toHaveAttribute('data-mode', 'SOMETHING_NEW');
  });

  it('★ treats a lower-case READY_MESSAGE as the mode it is', async () => {
    await show(ok({ copilotMode: 'ready_message', data: [{ id: 's1', text: 'Hi' }] }));
    expect(screen.getByTestId('suggestion-s1')).toBeInTheDocument();
  });
});

describe('★★ the suggestions themselves', () => {
  it('shows the draft and the model’s reasons, isolated', async () => {
    await show(
      ok({
        data: [
          {
            id: 's1',
            text: 'שלחנו את ההזמנה שלך היום',
            type: 'reply',
            confidence: 0.91,
            approach: 'Answer the shipping question directly',
            rationale: 'They asked twice',
          },
        ],
      }),
    );
    const item = screen.getByTestId('suggestion-s1');
    expect(item).toHaveTextContent('שלחנו את ההזמנה שלך היום');
    expect(item).toHaveTextContent('Answer the shipping question directly');
    expect(item).toHaveTextContent('They asked twice');
    expect(item.querySelector('bdi')).toHaveAttribute('dir', 'auto');
  });

  it('★★ shows confidence as a band, never as a percentage', async () => {
    /*
     * Two decimal places on a model's self-report is a precision claim nothing
     * supports.
     */
    await show(ok({ data: [{ id: 's1', text: 'Hi', confidence: 0.91 }] }));
    const meta = screen.getByTestId('suggestion-meta-s1');
    expect(meta).toHaveTextContent('Confident');
    expect(meta.textContent).not.toMatch(/9|%/);
  });

  it('★★ "not reported" is not "unsure"', async () => {
    /*
     * `null` means the model did not say. Filing that as low confidence tells an
     * agent to distrust a draft nothing has reported anything about.
     */
    await show(ok({ data: [{ id: 's1', text: 'Hi', confidence: null }] }));
    expect(screen.getByTestId('suggestion-meta-s1')).toHaveTextContent(/not reported/i);
  });

  it('★★ marks a proposed action as an action, and gives it no control', async () => {
    /*
     * Firing a tool is what the approvals screen exists for, with a keyboard
     * model built around this platform having no undo anywhere.
     */
    await show(ok({ data: [{ id: 's1', text: 'Refund the order', type: 'quick_action' }] }));
    const item = screen.getByTestId('suggestion-s1');
    expect(item).toHaveAttribute('data-draft', 'no');
    expect(item).toHaveTextContent(/an action it would take, not a reply/i);
    expect(item.querySelector('button')).toBeNull();
  });

  it('★★ no suggestion of any kind carries a button', async () => {
    // Including a draft: the control that would send it is the composer, which is
    // not built. A button with nowhere to put the text does nothing.
    await show(
      ok({
        data: [
          { id: 's1', text: 'A', type: 'reply' },
          { id: 's2', text: 'B', type: 'quick_action' },
        ],
      }),
    );
    expect(screen.getByTestId('copilot-panel').querySelectorAll('button')).toHaveLength(0);
  });
});
