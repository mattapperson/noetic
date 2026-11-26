/**
 * The version of a flow that runs JSON workflows, for a harness that was given no
 * `version` (spec 23 § Versions): a hash of every document the flow can run, so
 * an edited document is a new version without the host naming one.
 */

import type { Step } from '@noetic-tools/types';
import { flowSourceOf } from '../builders/flow-source';
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

//#endregion

//#region Public API

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
