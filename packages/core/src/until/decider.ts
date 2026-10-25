import type { DecideAnswer, DecideQuestion, StepDecide, Until, Verdict } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';

//#region Public API

/**
 * Turns a loop's `until` value into a predicate. A function passes through; a
 * decide step becomes a predicate that runs it on the iteration's output and
 * stops on a yes. Throws at once when the decide step is not a valid decider,
 * so a bad loop fails where it is built.
 *
 * @throws `NoeticConfigError` `INVALID_UNTIL_DECIDER` unless the decide step
 *   asks exactly one question and that question is boolean.
 */
export function toUntil<TContext>(pred: Until | StepDecide<TContext>): Until {
  if (typeof pred === 'function') {
    return pred;
  }
  const question = deciderQuestion(pred);
  return async (snapshot, run): Promise<Verdict> => {
    if (!run) {
      throw new NoeticConfigError({
        code: 'INVALID_UNTIL_DECIDER',
        message: `decide(${JSON.stringify(pred.id)}) used as an until predicate was called outside a loop.`,
        hint: 'Pass the decide step as a loop `until` (alone or inside any/all); the loop supplies what it needs to run.',
      });
    }
    const answers = frameworkCast<Record<string, DecideAnswer>>(
      await run.executeStep(frameworkCast<StepDecide>(pred), snapshot.lastOutput, run.ctx),
    );
    return verdictOf(pred.id, question, answers[question]);
  };
}

//#endregion

//#region Helpers

/** The decider's one question id; throws unless it asks exactly one boolean question. */
function deciderQuestion<TContext>(step: StepDecide<TContext>): string {
  const entries = Object.entries(step.questions);
  const [first] = entries;
  if (entries.length === 1 && first && first[1].type === 'boolean') {
    return first[0];
  }
  throw new NoeticConfigError({
    code: 'INVALID_UNTIL_DECIDER',
    message: `decide(${JSON.stringify(step.id)}) cannot end a loop: an until decider asks exactly one boolean question, but it asks ${describe(entries)}.`,
    hint: "Give the decider one boolean question, e.g. questions: { done: { type: 'boolean', instructions: 'Is the task finished?' } }.",
  });
}

function describe(
  entries: Array<
    [
      string,
      DecideQuestion,
    ]
  >,
): string {
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([id, q]) => `'${id}' (${q.type})`).join(', ');
}

/** Yes stops; no or a refusal continues. The reason names the question, answer, and probability. */
function verdictOf(stepId: string, question: string, answer: DecideAnswer | undefined): Verdict {
  if (!answer || answer.type !== 'boolean') {
    return {
      stop: false,
      reason: `decide '${stepId}' refused '${question}'; continuing`,
    };
  }
  return {
    stop: answer.value,
    reason: `decide '${stepId}' answered '${question}' ${answer.value ? 'yes' : 'no'} (p=${answer.probability.toFixed(2)})`,
  };
}

//#endregion
