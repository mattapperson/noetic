/**
 * A JSON workflow node's options read from the harness `params` (spec 26
 * § Options from params): where a TypeScript step takes a function, a node
 * names a param that holds one.
 *
 * A param is looked up on the context's harness every time its option is read,
 * and a function is called then. Nothing is kept between reads, so a host that
 * swaps a param, or one whose function gives a new answer, is seen at once.
 */

import type { Context, Lazy, WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import type { UntilPredicate } from '../schemas/workflow';

//#region Types

/** A node as its `fromParams` is read: only the id and the map matter. */
interface ParamNode {
  readonly id: string;
  readonly fromParams?: Readonly<Record<string, string | undefined>>;
}

/** A param a document names, and the option that names it. */
export interface ParamUse {
  readonly name: string;
  readonly where: string;
}

//#endregion

//#region Public API

/**
 * The value of harness param `name` now.
 *
 * @throws `NoeticConfigError` `UNKNOWN_PARAM_REFERENCE` when the harness has no such param.
 */
export function paramOf(ctx: Context, name: string, where: string): unknown {
  const params = ctx.harness.config.params;
  if (!Object.hasOwn(params, name)) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_PARAM_REFERENCE',
      message: `${where} reads harness param '${name}', which the harness does not have.`,
      hint: `Pass it in the harness params, e.g. new AgentHarness({ params: { ${name}: … } }). The harness has: ${Object.keys(params).join(', ') || '(none)'}.`,
    });
  }
  return params[name];
}

/**
 * An option read from `param`: a function is called with `args`, any other
 * value is the option's value.
 *
 * @throws `NoeticConfigError` `UNKNOWN_PARAM_REFERENCE` when the harness has no such param.
 */
export function fromParam(ctx: Context, param: ParamUse, args: ReadonlyArray<unknown>): unknown {
  const value = paramOf(ctx, param.name, param.where);
  return typeof value === 'function' ? value(...args) : value;
}

/**
 * The function `param` holds now.
 *
 * @throws `NoeticConfigError` `UNKNOWN_PARAM_REFERENCE` when the harness has no such param, `PARAM_NOT_A_FUNCTION` when it holds anything else.
 */
export function paramFunction(
  ctx: Context,
  param: ParamUse,
): (...args: ReadonlyArray<unknown>) => unknown {
  const value = paramOf(ctx, param.name, param.where);
  if (typeof value !== 'function') {
    throw new NoeticConfigError({
      code: 'PARAM_NOT_A_FUNCTION',
      message: `${param.where} calls harness param '${param.name}', which is not a function.`,
      hint: `Set params.${param.name} to a function.`,
    });
  }
  return (...args) => value(...args);
}

/**
 * An option whose TypeScript function is synchronous, read from `param`.
 *
 * @throws `NoeticConfigError` `PARAM_MUST_BE_SYNC` when the function gives a promise: the step would use the promise itself as the value.
 */
export function fromParamSync(
  ctx: Context,
  param: ParamUse,
  args: ReadonlyArray<unknown>,
): unknown {
  const value = fromParam(ctx, param, args);
  if (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    // The promise is dropped here; a rejection must not surface as unhandled.
    Promise.resolve(value).catch(() => {});
    throw new NoeticConfigError({
      code: 'PARAM_MUST_BE_SYNC',
      message: `${param.where} read harness param '${param.name}', whose function gave a promise.`,
      hint: `This option is read synchronously, as in TypeScript: make params.${param.name} return its value directly.`,
    });
  }
  return value;
}

/** Whether `ref` is a param a node reads, rather than a name or an expression. */
export function isParamUse(ref: unknown): ref is ParamUse {
  return typeof ref === 'object' && ref !== null && 'where' in ref && 'name' in ref;
}

/** The param `node` reads `option` from, with the place to name in errors; undefined when it reads none. */
export function paramFor(node: ParamNode, option: string): ParamUse | undefined {
  const name = node.fromParams?.[option];
  return name === undefined
    ? undefined
    : {
        name,
        where: `'${option}' of workflow node '${node.id}'`,
      };
}

/**
 * A step option that takes `(ctx) => value`, read from the param `node` names
 * for `option`; `fixed` when it names none.
 */
export function lazyOption<T>(node: ParamNode, option: string, fixed: Lazy<T>): Lazy<T> {
  const param = paramFor(node, option);
  if (!param) {
    return fixed;
  }
  // The param's value is the host's: its type is the option's by the host's word.
  return async (ctx) =>
    frameworkCast<T>(
      await fromParam(ctx, param, [
        ctx,
      ]),
    );
}

/**
 * A step's `emit` from a node: its boolean, or a filter read from the param it
 * names. A filter with no context to read params from lets the event through.
 */
export function emitOption(
  node: ParamNode & {
    readonly emit?: boolean;
  },
):
  | boolean
  | undefined
  | ((eventType: string, data: Record<string, unknown>, ctx?: Context) => boolean) {
  const param = paramFor(node, 'emit');
  if (!param) {
    return node.emit;
  }
  return (eventType, data, ctx) =>
    ctx === undefined ||
    fromParamSync(ctx, param, [
      eventType,
      data,
      ctx,
    ]) !== false;
}

/** Every harness param the nodes under `root` read, inline subflows included. */
export function paramUses(root: WorkflowNode): ParamUse[] {
  const uses: ParamUse[] = [];
  for (const node of walkWorkflow(root)) {
    for (const [option, name] of Object.entries(node.fromParams ?? {})) {
      uses.push({
        name,
        where: `'${option}' of workflow node '${node.id}'`,
      });
    }
    if (node.kind === 'loop') {
      uses.push(...untilParams(node.until, node.id));
    }
  }
  return uses;
}

/**
 * Checks the params a document reads against the ones a host lets it read.
 *
 * @throws `NoeticConfigError` `PARAM_NOT_ALLOWED` for a param outside `allowed`.
 */
export function checkParamGrants(doc: WorkflowDocument, allowed: ReadonlyArray<string>): void {
  const refused = paramUses(doc.root).find((use) => !allowed.includes(use.name));
  if (!refused) {
    return;
  }
  throw new NoeticConfigError({
    code: 'PARAM_NOT_ALLOWED',
    message: `${refused.where} reads harness param '${refused.name}', which this document may not read.`,
    hint: `Grant it with params: [${[
      ...allowed,
      refused.name,
    ]
      .map((name) => `'${name}'`)
      .join(', ')}], or take it out of the document.`,
  });
}

/** What a planner is told of the params its document may read; nothing when there are none. */
export function paramsPrompt(allowed: ReadonlyArray<string> | undefined): string | undefined {
  if (!allowed || allowed.length === 0) {
    return undefined;
  }
  return `\nHarness params a node may read: ${allowed.join(', ')}. A node reads one with "fromParams": { "<option>": "<param>" } in place of writing the option, e.g. { "kind": "runCode", "id": "<unique>", "fromParams": { "execute": "<param>" } } runs that function on the node's input, and "fromParams": { "model": "<param>" } on a callModel node reads its model. Use only the params listed, and only where the task calls for one.`;
}

/** The options a document the host did not write may not read from a param: no grant can check what they give. */
const UNCHECKED_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  callModel: [
    'tools',
  ],
  'acp-agent': [
    'tools',
    'cwd',
    'mode',
    'model',
    'onPermissionRequest',
  ],
  call: [
    'connection',
  ],
  wait: [
    'connection',
  ],
  verify: [
    'subject',
  ],
};

/**
 * Refuses, in a document the host did not write, options that decide what a
 * node may reach when they are read from a param: the connection and ACP
 * grants are checked against the document, and cannot see a value a function
 * gives at run time.
 *
 * @throws `NoeticConfigError` `PARAM_NOT_ALLOWED` for such an option.
 */
export function checkUncheckedOptions(doc: WorkflowDocument): void {
  for (const node of walkWorkflow(doc.root)) {
    const option = (UNCHECKED_OPTIONS[node.kind] ?? []).find(
      (name) => paramFor(node, name) !== undefined,
    );
    if (option === undefined) {
      continue;
    }
    throw new NoeticConfigError({
      code: 'PARAM_NOT_ALLOWED',
      message: `'${option}' of workflow node '${node.id}' is read from a harness param, which this document may not do: its grants cannot check what the param gives.`,
      hint: `Write '${option}' on the node, within what the host grants, or run the document with hydrateWorkflow as one the host wrote.`,
    });
  }
}

//#endregion

//#region Helpers

function untilParams(pred: UntilPredicate, loopId: string): ParamUse[] {
  if (pred.kind === 'param') {
    return [
      {
        name: pred.name,
        where: `until of loop node '${loopId}'`,
      },
    ];
  }
  if (pred.kind === 'any' || pred.kind === 'all') {
    return pred.predicates.flatMap((child) => untilParams(child, loopId));
  }
  return [];
}

//#endregion
