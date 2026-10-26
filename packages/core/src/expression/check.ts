/**
 * Finds expressions in a workflow tree that do not parse, so a document's
 * JSONata syntax errors fail validation instead of surfacing mid-run.
 */

import type { UntilPredicate, WorkflowNode } from '@noetic-tools/types';
import { walkWorkflow } from '@noetic-tools/types';
import { syntaxError } from './jsonata';

//#region Types

/** An expression in the tree and the place it sits, for error messages. */
interface Found {
  where: string;
  source: string;
}

//#endregion

//#region Public API

/**
 * Lists a message for every expression in the tree under `root` that fails
 * to parse. Empty when all parse. Named `subflow` refs are not followed; their
 * expressions compile when the referenced document hydrates.
 */
export function expressionErrors(root: WorkflowNode): string[] {
  const errors: string[] = [];
  for (const node of walkWorkflow(root)) {
    for (const found of expressionsOf(node)) {
      const error = syntaxError(found.source);
      if (error !== undefined) {
        errors.push(`Expression in ${found.where} does not parse: ${error}`);
      }
    }
  }
  return errors;
}

//#endregion

//#region Helpers

function expressionsOf(node: WorkflowNode): Found[] {
  if (node.kind === 'compute') {
    return [
      {
        where: `compute node '${node.id}'`,
        source: node.expr,
      },
    ];
  }
  if (node.kind === 'conditional') {
    return node.routes.flatMap((route, i) =>
      route.expr === undefined
        ? []
        : [
            {
              where: `route ${i} of conditional node '${node.id}'`,
              source: route.expr,
            },
          ],
    );
  }
  if (node.kind === 'loop') {
    return untilTests(node.until, `until of loop node '${node.id}'`);
  }
  return [];
}

function untilTests(pred: UntilPredicate, where: string): Found[] {
  if (pred.kind === 'expr') {
    return [
      {
        where,
        source: pred.expr,
      },
    ];
  }
  if (pred.kind === 'any' || pred.kind === 'all') {
    return pred.predicates.flatMap((child) => untilTests(child, where));
  }
  return [];
}

//#endregion
