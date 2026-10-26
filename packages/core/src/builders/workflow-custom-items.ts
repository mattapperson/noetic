/**
 * Custom items in JSON workflows (spec 34): live items from a document's JSON Schema
 * declarations, their scopes (document root, node, subflow), and a node's `emitItems`
 * hooks built from expressions.
 */

import type {
  CustomItem,
  CustomItemMap,
  CustomItemType,
  StepEmitItemsOption,
  WorkflowCustomItem,
  WorkflowDocument,
  WorkflowEmitItems,
  WorkflowNode,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import type { ExpressionLimits } from '../expression/jsonata';
import { compileExpression, computeMaybe, readInput } from '../expression/jsonata';
import { customItem } from './custom-item';
import { outputText } from './output-text';

//#region Public API

/**
 * The items a document's steps may emit. Precedence, lowest first: the enclosing
 * scope, the document's root `customItems`, then `typed` (TypeScript declarations for
 * this document). A name in both `typed` and the document must carry one `type`.
 *
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_MISMATCH` when `typed` and the
 * document declare one name with different types, and anything `customItem()` throws.
 */
export function documentScope(
  doc: WorkflowDocument,
  outer: CustomItemMap | undefined,
  typed?: CustomItemMap,
): CustomItemMap {
  const declared = liveItems(doc.customItems);
  for (const [name, item] of Object.entries(typed ?? {})) {
    const own = declared[name];
    if (own && own.type !== item.type) {
      throw new NoeticConfigError({
        code: 'CUSTOM_ITEM_MISMATCH',
        message: `Custom item '${name}' is '${item.type}' in workflow() but '${own.type}' in its document.`,
        hint: 'Give both declarations the same type, or rename one of them.',
      });
    }
  }
  return {
    ...outer,
    ...declared,
    ...typed,
  };
}

/** The items one node may emit: its scope plus the node's own declarations. */
export function nodeScope(node: WorkflowNode, scope: CustomItemMap | undefined): CustomItemMap {
  return {
    ...scope,
    ...liveItems(node.customItems),
  };
}

/**
 * Every custom item a document declares at any level (its root, its nodes, its inline
 * subflows), keyed by type, so a harness can accept a log that holds any of them.
 */
export function everyDocumentItem(doc: WorkflowDocument): CustomItemMap {
  const found: CustomItem[] = Object.values(liveItems(doc.customItems));
  for (const node of walkWorkflow(doc.root)) {
    found.push(...Object.values(liveItems(node.customItems)));
    if (node.kind === 'subflow' && node.document) {
      found.push(...Object.values(liveItems(node.document.customItems)));
    }
  }
  return Object.fromEntries(
    found.map((item) => [
      item.type,
      item,
    ]),
  );
}

/**
 * Hydrates a node's `emitItems`. `true` and `false` pass through. The hook form's
 * `onStart` expression, read against the input, yields one event of the named item;
 * `onDone`, read against the output, gives its final fields, or message text when no
 * item is named. An expression that gives no value emits nothing for that hook.
 *
 * @throws `NoeticConfigError` with code `UNKNOWN_CUSTOM_ITEM` when `item` names no item
 * in `scope`, and `WORKFLOW_VALIDATION_FAILED` when an expression does not parse.
 */
export function hydrateEmitItems({
  nodeId,
  option,
  scope,
  limits,
}: {
  nodeId: string;
  option: WorkflowEmitItems;
  scope: CustomItemMap;
  limits: ExpressionLimits | undefined;
}): StepEmitItemsOption {
  if (typeof option === 'boolean') {
    return option;
  }
  const where = `emitItems of node '${nodeId}'`;
  const onStart =
    option.onStart === undefined ? undefined : compileExpression(option.onStart, where, limits);
  const onDone =
    option.onDone === undefined ? undefined : compileExpression(option.onDone, where, limits);
  if (option.item === undefined) {
    return {
      onDone: onDone && (async (output) => textOf(await computeMaybe(onDone, readInput(output)))),
    };
  }
  if (!scope[option.item]) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_CUSTOM_ITEM',
      message: `Node '${nodeId}' emits custom item '${option.item}', which is not in its scope.`,
      hint: "Declare it in the node's customItems or the document root's customItems.",
    });
  }
  return {
    item: option.item,
    onStart:
      onStart &&
      async function* (input) {
        const event = await computeMaybe(onStart, readInput(input));
        if (event !== undefined) {
          yield event;
        }
        return undefined;
      },
    onDone: onDone && ((output) => computeMaybe(onDone, readInput(output))),
  };
}

//#endregion

//#region Helpers

function liveItems(declared: Record<string, WorkflowCustomItem> | undefined): CustomItemMap {
  return Object.fromEntries(
    Object.entries(declared ?? {}).map(([name, item]) => [
      name,
      customItem({
        type: frameworkCast<CustomItemType>(item.type),
        description: item.description,
        event: item.event,
        output: item.output,
      }),
    ]),
  );
}

function textOf(value: unknown): string | undefined {
  return value === undefined ? undefined : outputText(value);
}

//#endregion
