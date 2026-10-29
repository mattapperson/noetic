/**
 * Finds expressions in a workflow tree that do not parse, so a document's
 * JSONata syntax errors fail validation instead of surfacing mid-run.
 */

import type {
  UntilPredicate,
  WorkflowConnectionRef,
  WorkflowNode,
  WorkflowStepList,
} from '@noetic-tools/types';
import { isWorkflowOpShorthand, stepListEntries, walkWorkflow } from '@noetic-tools/types';
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
  const option = typeof node.emitItems === 'object' ? node.emitItems : {};
  const emitted = [
    option.onStart,
    option.onDone,
  ].flatMap((source) =>
    source === undefined
      ? []
      : [
          {
            where: `emitItems of node '${node.id}'`,
            source,
          },
        ],
  );
  return [
    ...emitted,
    ...kindExpressionsOf(node),
  ];
}

function kindExpressionsOf(node: WorkflowNode): Found[] {
  const connection = connectionExpressionsOf(node);
  if (connection !== undefined) {
    return connection;
  }
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

/** Expressions in connection nodes (spec 35): `$expr` values, connection refs, wait filters, verify subjects, and shorthand args. */
function connectionExpressionsOf(node: WorkflowNode): Found[] | undefined {
  switch (node.kind) {
    case 'call':
      return [
        ...refExpressions(node.connection, `connection of call node '${node.id}'`),
        ...valueExpressions(node.args, `args of call node '${node.id}'`),
      ];
    case 'wait':
      return [
        ...refExpressions(node.connection, `connection of wait node '${node.id}'`),
        ...(node.filter === undefined
          ? []
          : [
              {
                where: `filter of wait node '${node.id}'`,
                source: node.filter,
              },
            ]),
        ...shorthandExpressions(node.around, node.id),
      ];
    case 'verify':
      return [
        ...(Array.isArray(node.subject) || typeof node.subject === 'string'
          ? []
          : refExpressions(node.subject, `subject of verify node '${node.id}'`)),
        ...shorthandExpressions(node.act, node.id),
      ];
    case 'sequence':
      return shorthandExpressions(node.steps, node.id);
    default:
      return undefined;
  }
}

function refExpressions(ref: WorkflowConnectionRef | undefined, where: string): Found[] {
  if (ref === undefined || typeof ref === 'string') {
    return [];
  }
  return [
    {
      where,
      source: ref.$expr,
    },
  ];
}

/** Every `{ "$expr" }` in a value; `$literal` contents are data, not expressions. */
function valueExpressions(value: unknown, where: string): Found[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => valueExpressions(v, where));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if ('$literal' in value) {
    return [];
  }
  if ('$expr' in value && typeof value.$expr === 'string') {
    return [
      {
        where,
        source: value.$expr,
      },
    ];
  }
  return Object.values(value).flatMap((v) => valueExpressions(v, where));
}

/** Expressions in the args of operations written by name in a step list. */
function shorthandExpressions(list: WorkflowStepList | undefined, parentId: string): Found[] {
  if (list === undefined) {
    return [];
  }
  return stepListEntries(list).flatMap((entry) =>
    isWorkflowOpShorthand(entry)
      ? Object.entries(entry).flatMap(([op, args]) =>
          valueExpressions(args, `args of operation '${op}' in node '${parentId}'`),
        )
      : [],
  );
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
