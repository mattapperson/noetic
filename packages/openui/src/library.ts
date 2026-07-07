/**
 * Component library model: `defineComponent` / `createLibrary`, the generated
 * system prompt, and document validation against the registered components.
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { z } from 'zod';
import type { UiAssignment, UiDocument, UiExpr } from './lang/document';
import { OPENUI_LANG_DIALECT } from './lang/document';

/** A prop schema as it appears in `ZodObject.shape` (Zod v4 core type). */
type PropSchema = z.core.$ZodType;

//#region Definitions

/** @public One registered component: its name, docs, and ordered prop schemas. */
export interface ComponentDefinition<N extends string = string> {
  name: N;
  description?: string;
  /**
   * Prop schemas. Positional arguments in OpenUI Lang map to props by key
   * declaration order (Zod preserves shape insertion order).
   */
  props?: ZodObject<ZodRawShape>;
}

/** @public Declare a component the model (or a tool) may render. */
export function defineComponent<const N extends string>(
  def: ComponentDefinition<N>,
): ComponentDefinition<N> {
  return def;
}

/**
 * Components every library accepts implicitly: data bindings, action blocks,
 * and the slot that mounts a tool-owned region into a model-authored layout.
 */
export const BUILTIN_COMPONENTS = [
  'Action',
  'Query',
  'Mutation',
  'ToolView',
] as const;

const BUILTIN_COMPONENT_SET: ReadonlySet<string> = new Set(BUILTIN_COMPONENTS);

/** @public A registered component library — the vocabulary a surface renders. */
export interface UiLibrary<N extends string = string> {
  dialect: string;
  components: ReadonlyMap<string, ComponentDefinition>;
  componentNames: readonly N[];
  /** The generated component-library prompt appended to a step's instructions. */
  systemPrompt(): string;
}

/** @public Options for `createLibrary`. */
export interface CreateLibraryOptions {
  dialect?: string;
}

/** @public Build a library from component definitions. */
export function createLibrary<const D extends readonly ComponentDefinition[]>(
  definitions: D,
  options?: CreateLibraryOptions,
): UiLibrary<D[number]['name']> {
  const components = new Map<string, ComponentDefinition>();
  for (const def of definitions) {
    if (components.has(def.name)) {
      throw new Error(`duplicate component name '${def.name}' in library`);
    }
    components.set(def.name, def);
  }
  const dialect = options?.dialect ?? OPENUI_LANG_DIALECT;
  return {
    dialect,
    components,
    componentNames: definitions.map((d) => d.name),
    systemPrompt: () =>
      renderLibraryPrompt(dialect, [
        ...components.values(),
      ]),
  };
}

//#endregion

//#region Prop introspection

export interface PropSignature {
  name: string;
  /** Human-readable type rendered into the prompt (`string`, `number`, `array`, …). */
  type: string;
  optional: boolean;
  schema: PropSchema;
}

/** Ordered prop signatures for a component (declaration order). */
export function componentProps(def: ComponentDefinition): PropSignature[] {
  if (!def.props) {
    return [];
  }
  return Object.entries(def.props.shape).map(([name, schema]) => ({
    name,
    type: describeSchema(schema),
    optional: z.safeParse(schema, undefined).success,
    schema,
  }));
}

function describeSchema(schema: PropSchema): string {
  try {
    const json = z.toJSONSchema(schema, {
      io: 'input',
    });
    if (typeof json.type === 'string') {
      return json.type;
    }
    if (Array.isArray(json.anyOf)) {
      const types = json.anyOf
        .map((s) => (typeof s === 'object' && s !== null && 'type' in s ? String(s.type) : 'any'))
        .filter((t) => t !== 'null');
      if (types.length > 0) {
        return types.join(' | ');
      }
    }
    if (Array.isArray(json.enum)) {
      return json.enum.map((v) => JSON.stringify(v)).join(' | ');
    }
  } catch {
    // Exotic schema — fall through to the permissive label.
  }
  return 'any';
}

//#endregion

//#region Prompt generation

function renderComponentLine(def: ComponentDefinition): string {
  const props = componentProps(def)
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ');
  const doc = def.description ? ` — ${def.description}` : '';
  return `- ${def.name}(${props})${doc}`;
}

function renderLibraryPrompt(dialect: string, definitions: ComponentDefinition[]): string {
  return [
    `Respond in OpenUI Lang (${dialect}): one assignment statement per line, \`name = Expression\`.`,
    'Rules:',
    '- Components: `ref = Component(arg1, arg2, ...)` — positional args map to props in signature order.',
    '- The statement assigned to `root` is the rendered root.',
    '- Reactive state: `$name = defaultValue`. Passing `$name` to an input two-way binds it.',
    '- Data: `ref = Query("tool_name", { args })` fetches on load and when referenced `$vars` change; `ref = Mutation("tool_name", { args })` runs only via `@Run(ref)`.',
    '- Actions: `Action([@Run(ref), @Set($var, value), @ToAssistant("message")])` — steps run sequentially.',
    '- Reference other statements by their `ref`. Member access plucks fields (`data.rows.title`).',
    '- Emit only OpenUI Lang statements — no prose, no code fences.',
    '',
    'Available components:',
    ...definitions.map(renderComponentLine),
  ].join('\n');
}

//#endregion

//#region Validation

/** @public One problem found validating a document against a library. */
export interface UiValidationIssue {
  ref: string;
  component: string;
  message: string;
}

function collectCalls(
  expr: UiExpr,
  out: Array<
    Extract<
      UiExpr,
      {
        kind: 'call';
      }
    >
  >,
): void {
  switch (expr.kind) {
    case 'call':
      if (!expr.builtin) {
        out.push(expr);
      }
      for (const arg of expr.args) {
        collectCalls(arg, out);
      }
      return;
    case 'array':
      for (const item of expr.items) {
        collectCalls(item, out);
      }
      return;
    case 'member':
      collectCalls(expr.base, out);
      return;
    case 'object':
      for (const entry of expr.entries) {
        collectCalls(entry.value, out);
      }
      return;
    default:
      return;
  }
}

function validateCall(
  assignment: UiAssignment,
  call: Extract<
    UiExpr,
    {
      kind: 'call';
    }
  >,
  library: UiLibrary,
): UiValidationIssue[] {
  if (BUILTIN_COMPONENT_SET.has(call.fn)) {
    return [];
  }
  const def = library.components.get(call.fn);
  if (!def) {
    return [
      {
        ref: assignment.ref,
        component: call.fn,
        message: `unknown component '${call.fn}'`,
      },
    ];
  }
  const props = componentProps(def);
  const issues: UiValidationIssue[] = [];
  if (call.args.length > props.length) {
    issues.push({
      ref: assignment.ref,
      component: call.fn,
      message: `too many arguments: got ${call.args.length}, signature has ${props.length}`,
    });
  }
  call.args.forEach((arg, i) => {
    const prop = props[i];
    if (!prop || arg.kind !== 'literal') {
      return; // refs/state/calls are dynamic — validated at runtime, not statically
    }
    const parsed = z.safeParse(prop.schema, arg.value);
    if (!parsed.success) {
      issues.push({
        ref: assignment.ref,
        component: call.fn,
        message: `prop '${prop.name}' rejects ${JSON.stringify(arg.value)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      });
    }
  });
  return issues;
}

/**
 * Validate every component call in a document against the library: unknown
 * components, arity overflow, and literal prop mismatches. Dynamic args
 * (refs, `$state`, nested calls) are skipped — they resolve at render time.
 * @public
 */
export function validateDocument(library: UiLibrary, doc: UiDocument): UiValidationIssue[] {
  const issues: UiValidationIssue[] = [];
  for (const ref of doc.order) {
    const assignment = doc.assignments[ref];
    if (!assignment) {
      continue;
    }
    const calls: Array<
      Extract<
        UiExpr,
        {
          kind: 'call';
        }
      >
    > = [];
    collectCalls(assignment.expr, calls);
    for (const call of calls) {
      issues.push(...validateCall(assignment, call, library));
    }
  }
  return issues;
}

//#endregion
