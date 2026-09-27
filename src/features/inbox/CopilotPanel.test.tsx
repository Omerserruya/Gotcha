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

describe('★★ the provider reports its own failures inside the list, as a 200', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * A SUPPORT AGENT WAS BEING TOLD TO CHECK AN API KEY
   * ════════════════════════════════════════════════════════════════════════════
   * A browser walk read this out of the live panel, in the position where a draft
   * reply goes:
   *
   *     Failed to get AI suggestions. Check API key and model configuration.
   *
   * Not an envelope, not a status, not a 402 — a one-item list with a sentinel id,
   * on a 200 with content, so the four empty states above were structurally unable
   * to see it. Six sentinels exist; they were found by grepping the provider rather
   * than by fixing the one string in the screenshot.
   */
  const sentinel = (id: string, text: string, over: Record<string, unknown> = {}): CopilotRead =>
    ok({ data: [{ id, text, confidence: 0, type: 'info', ...over }] });

  it('★★ never shows the operational error, and says nothing is wrong with the conversation', async () => {
    await show(
      sentinel('error', 'Failed to get AI suggestions. Check API key and model configuration.'),
    );
    const note = screen.getByTestId('copilot-sentinel-note');
    expect(note).not.toHaveTextContent(/API key/i);
    expect(note).not.toHaveTextContent(/model configuration/i);
    expect(note).toHaveTextContent(/nothing is wrong with the conversation/i);
  });

  it('★★ tells apart the five sentinels, because they want different actions', async () => {
    /*
     * A failed provider is nobody's fault; a switched-off Copilot and a missing
     * employee are somebody's setting. Folding them into one "unavailable" would
     * leave an admin unable to tell a fault from a switch.
     */
    const cases: [string, RegExp][] = [
      ['error', /couldn’t draft a reply just now/i],
      ['stub-1', /no AI provider set up/i],
      ['disabled', /switched off for this workspace/i],
      ['no-config', /no AI employee to draft with/i],
      ['no-match', /write the reply yourself/i],
    ];
    for (const [id, expected] of cases) {
      const { unmount } = await show(sentinel(id, 'whatever the provider wrote'));
      expect(screen.getByTestId('copilot-sentinel-note'), id).toHaveTextContent(expected);
      unmount();
    }
  });

  it('★★ names who can act, and never hands over an operational instruction', async () => {
    /*
     * "Ask somebody who can change this" is advice a support agent can use.
     * "Check API key and model configuration" is not, and it is what shipped.
     */
    for (const id of ['stub-1', 'disabled']) {
      const { unmount } = await show(sentinel(id, 'x'));
      expect(screen.getByTestId('copilot-sentinel-note'), id).toHaveTextContent(/admin role/i);
      unmount();
    }
  });

  it('★★ never renders the provider’s own sentence, whatever it says', async () => {
    // The text is not paraphrased, it is discarded. A future wording change at the
    // provider cannot leak through, because nothing here reads the string.
    await show(sentinel('error', 'Set OPENAI_API_KEY in the environment'));
    expect(screen.queryByText(/OPENAI_API_KEY/)).toBeNull();
  });

  it('★★ a REAL draft the provider could not structure is kept, and called a reply', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE SIXTH SENTINEL IS NOT A SENTINEL
     * ════════════════════════════════════════════════════════════════════════
     * `openai-text` carries the model's own content with `confidence: 0.5`; the
     * provider emits it when ITS structured parse failed, not when the model did.
     * Suppressing it throws away a usable reply, and honouring its `type: info`
     * labels a draft as "an action it would take" — the opposite of true.
     */
    await show(
      ok({
        data: [
          { id: 'openai-text', text: 'We posted it this morning.', confidence: 0.5, type: 'info' },
        ],
      }),
    );
    expect(screen.queryByTestId('copilot-sentinel')).toBeNull();
    const item = screen.getByTestId('suggestion-openai-text');
    expect(item).toHaveTextContent('We posted it this morning.');
    expect(item).toHaveAttribute('data-draft', 'yes');
    expect(item).not.toHaveTextContent(/an action it would take/i);
  });

  it('★★ a sentinel id beside real suggestions does not swallow them', async () => {
    /*
     * The provider returns a sentinel INSTEAD of suggestions, never beside them, so
     * detection requires a list of exactly one. A genuine suggestion that happened
     * to carry one of these ids must not be able to hide the others.
     */
    await show(
      ok({
        data: [
          { id: 'error', text: 'Some reply', type: 'reply' },
          { id: 's2', text: 'Another reply', type: 'reply' },
        ],
      }),
    );
    expect(screen.queryByTestId('copilot-sentinel')).toBeNull();
    /*
     * The lookahead matters: `/^suggestion-/` also matches `suggestion-meta-*`
     * and `suggestion-approach-*`, so the first version of this counted four and
     * read as the code keeping too much. The assertion was imprecise, not the
     * component — the same shape as the textarea that carried its own text.
     */
    expect(screen.getAllByTestId(/^suggestion-(?!meta-|approach-)/)).toHaveLength(2);
  });
});
