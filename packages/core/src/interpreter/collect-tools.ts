import type { Step, StepAcpAgent, StepCallModel, StepToolEntry, Tool } from '@noetic-tools/types';
import {
  frameworkCast,
  isConnectionEntry,
  isConnectionPick,
  isServerToolSpec,
  NoeticConfigError,
} from '@noetic-tools/types';
import { documentEntriesOf } from '../builders/document-entries';
import { namedFromList } from '../connections/entries';
import { unknownConnectionError } from '../connections/errors';
import type { StepConnections } from '../connections/step-tools';
import { offeredTools, splitStepTools } from '../connections/step-tools';
import type { AttachedEntry } from '../types/connection-entry';
import { stepChildren } from './step-walk';

/**
 * Recursively walks a step tree and collects all Tool instances
 * declared on LLM steps. Used to build the unified tool set
 * that gets sent with every LLM call for prompt cache efficiency.
 */
export function collectAllTools<TContext = unknown, I = unknown, O = unknown>(
  step: Step<TContext, I, O>,
): Tool[] {
  const tools: Tool[] = [];
  // walkStep uses Step with defaults (unknown generics); the cast is safe because
  // we only read the `.tools`, `.child`, `.steps`, `._optimizable` structural fields.
  walkStep(frameworkCast<Step>(step), tools);
  return deduplicateTools(tools);
}

/**
 * The connection entries a step tree lists in its `callModel` and `acpAgent`
 * steps' eager `tools` (an entry, or a pick made from one), and those a JSON
 * document's `connections` declare, named, so the turn connects them with its
 * own before its tool set is built. Repeats of one entry fold together.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for an entry with no name.
 */
export function collectStepEntries(step: Step): AttachedEntry[] {
  const found: AttachedEntry[] = [];
  walkModelSteps(step, (model, tools) => {
    const where = `${model.kind === 'callModel' ? 'callModel' : 'acpAgent'}('${model.id}') tools`;
    for (const entry of tools) {
      const listed = isConnectionPick(entry) ? entry.entry : entry;
      if (listed === undefined || !isConnectionEntry(listed)) {
        continue;
      }
      found.push({
        ...namedFromList(listed, where),
        scope: 'step',
        where,
      });
    }
  });
  walkSteps(step, (each) => {
    found.push(...documentEntriesOf(each));
  });
  return found;
}

/**
 * Checks that every connection a model step picks by name is one the turn
 * can see — the harness's, the turn's, or one a step or document attaches —
 * once they are attached, so a misspelt name fails before any step runs.
 *
 * @throws NoeticConfigError `CONNECTION_UNKNOWN` for a pick naming no connection.
 */
export function checkPickNames(step: Step, turn: StepConnections): void {
  const visible = turn.runtime.visibleNames(turn.rootId);
  walkModelSteps(step, (_model, tools) => {
    for (const entry of tools) {
      if (!isConnectionPick(entry) || visible.includes(entry.connection)) {
        continue;
      }
      throw unknownConnectionError(entry.connection, visible);
    }
  });
}

/**
 * Checks each model step that forces a tool (`toolChoice: { tool }`) and lists
 * connections: the tool must be one the step is offered from the turn's set.
 * Connection tool names come from the server, so the builder could not check
 * them.
 *
 * @throws NoeticConfigError `UNKNOWN_TOOL_CHOICE` when the forced tool is not offered.
 */
export function checkToolChoices(
  step: Step,
  unified: ReadonlyArray<Tool>,
  turn: StepConnections | undefined,
): void {
  walkModelSteps(step, (model, tools) => {
    if (model.kind !== 'callModel') {
      return;
    }
    const choice = model.toolChoice;
    if (typeof choice !== 'object') {
      return;
    }
    const listed = splitStepTools(tools);
    if (listed.picks.length === 0) {
      return;
    }
    const offered = (offeredTools(unified, listed, turn) ?? []).map((tool) => tool.name);
    if (offered.includes(choice.tool)) {
      return;
    }
    throw new NoeticConfigError({
      code: 'UNKNOWN_TOOL_CHOICE',
      message: `callModel(${JSON.stringify(model.id)}) forces tool ${JSON.stringify(choice.tool)}, which its tools do not offer this turn.`,
      hint: `Force one of the tools it is offered (${offered.join(', ') || 'none'}), or drop \`toolChoice\`.`,
    });
  });
}

/**
 * Deduplicates tools by name, keeping the first occurrence.
 */
export function deduplicateTools(tools: ReadonlyArray<Tool>): Tool[] {
  const seen = new Map<string, Tool>();
  for (const tool of tools) {
    if (!seen.has(tool.name)) {
      seen.set(tool.name, tool);
    }
  }
  return [
    ...seen.values(),
  ];
}

function walkStep(step: Step, out: Tool[]): void {
  // Inline server-tool specs (web search/fetch) are not client `Tool`s, and
  // connection entries and picks name tools the turn builds from its
  // connections — neither enters the pool from here.
  walkModelSteps(step, (_model, tools) => {
    for (const entry of tools) {
      if (!isServerToolSpec(entry) && !isConnectionPick(entry) && !isConnectionEntry(entry)) {
        out.push(entry);
      }
    }
  });
}

function walkSteps(step: Step, visit: (step: Step) => void): void {
  visit(step);
  for (const child of stepChildren(step)) {
    walkSteps(child, visit);
  }
}

/**
 * Calls `visit` with each `callModel` and `acpAgent` step and its eager
 * `tools`. Function-form tools are resolved per execution from `ctx` and
 * cannot contribute to the pre-computed unified set; consumers that need those
 * tools in the pool register them via `AgentHarness.tools` instead.
 */
function walkModelSteps(
  step: Step,
  visit: (step: StepCallModel | StepAcpAgent, tools: ReadonlyArray<StepToolEntry>) => void,
): void {
  if (step.kind !== 'callModel' && step.kind !== 'acp-agent') {
    for (const child of stepChildren(step)) {
      walkModelSteps(child, visit);
    }
    return;
  }
  if (step.tools !== undefined && typeof step.tools !== 'function') {
    visit(step, step.tools);
  }
}
