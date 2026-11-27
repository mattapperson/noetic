/**
 * The version of a flow that runs JSON workflows, for a harness that was given no
 * `version` (spec 23 § Versions): a hash of every document the flow can run, so
 * an edited document is a new version without the host naming one.
 */

import type { Step, WorkflowDocument } from '@noetic-tools/types';
import { NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import { flowSourceOf } from '../builders/flow-source';
import { paramUses } from '../builders/workflow-params';
import type { WorkflowSource } from '../builders/workflow-source';
import { stepChildren } from '../interpreter/step-walk';
import { hashText } from '../runtime/durable/step-ledger';

//#region Helpers

/** Every step in the tree under `root`, itself included, as far as it is statically known. */
function stepsIn(root: Step): Step[] {
  const found: Step[] = [];
  const seen = new Set<Step>();
  const queue: Step[] = [
    root,
  ];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    found.push(next);
    queue.push(...stepChildren(next));
  }
  return found;
}

/** A plain object's entries in key order, so two spellings of one document hash alike. */
function sortKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Whether a flow's source is a JSON workflow's: its document, or the name of one, and the named workflows. */
function isWorkflowSource(source: unknown): source is WorkflowSource {
  return (
    typeof source === 'object' && source !== null && 'document' in source && 'workflows' in source
  );
}

/**
 * Every document a flow's source can run: its own, or the one its name stands
 * for, and the named ones their subflow refs reach.
 */
function documentsOf(source: unknown): WorkflowDocument[] {
  if (!isWorkflowSource(source)) {
    return [];
  }
  const named = (ref: string): WorkflowDocument | undefined =>
    source.workflows && Object.hasOwn(source.workflows, ref) ? source.workflows[ref] : undefined;
  const found = new Set<WorkflowDocument>();
  const queue: Array<WorkflowDocument | undefined> = [
    source.document ?? undefined,
    source.ref === null ? undefined : named(source.ref),
  ];
  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || found.has(next)) {
      continue;
    }
    found.add(next);
    for (const node of walkWorkflow(next.root)) {
      if (node.kind === 'subflow' && node.ref !== undefined) {
        queue.push(named(node.ref));
      }
    }
  }
  return [
    ...found,
  ];
}

//#endregion

//#region Public API

/**
 * The error to fail with when a JSON workflow in `graph` reads a harness param
 * (`fromParams`) that `params` does not hold, else undefined. Checked before
 * any step runs, so a misspelled param fails the run at its start rather than
 * when its node is reached.
 */
export function unknownFlowParam(
  graph: Step,
  params: Readonly<Record<string, unknown>>,
): NoeticConfigError | undefined {
  const unknown = stepsIn(graph)
    .flatMap((step) => documentsOf(flowSourceOf(step)?.source))
    .flatMap((document) => paramUses(document.root))
    .find((use) => !Object.hasOwn(params, use.name));
  return unknown
    ? new NoeticConfigError({
        code: 'UNKNOWN_PARAM_REFERENCE',
        message: `${unknown.where} reads harness param '${unknown.name}', which the harness does not have.`,
        hint: `Pass it in the harness params, e.g. new AgentHarness({ params: { ${unknown.name}: … } }).`,
      })
    : undefined;
}

/**
 * The version of the flows in `graph`: a hash of the source of each step in it
 * that has one (a JSON workflow document and the named workflows it can refer
 * to), the same whatever order their keys were written in. Undefined when no step
 * of `graph` has a source, or one cannot be encoded.
 */
export function flowVersionOf(graph: Step | undefined): string | undefined {
  if (!graph) {
    return undefined;
  }
  const sources = stepsIn(graph).flatMap((step) => {
    const flow = flowSourceOf(step);
    return flow
      ? [
          flow.source,
        ]
      : [];
  });
  if (sources.length === 0) {
    return undefined;
  }
  try {
    return `workflow-${hashText(JSON.stringify(sources, sortKeys))}`;
  } catch {
    return undefined;
  }
}

//#endregion
