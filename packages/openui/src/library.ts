/**
 * Component library model: `defineComponent` / `createLibrary`, the generated
 * system prompt, and document validation against the registered components.
 *
 * The library, its JSON schema, prompt generation, and structural validation
 * are all delegated to `@openuidev/lang-core` — the source of truth for the
 * OpenUI Lang language. This module is the thin Noetic-facing adapter: it keeps
 * the renderer-free `defineComponent` shape agents use on the server and maps
 * lang-core's structured parse errors back to Noetic's `UiValidationIssue`.
 */

import type {
  Library,
  LibraryJSONSchema,
  PromptOptions,
  ValidationError,
} from '@openuidev/lang-core';
import * as langCore from '@openuidev/lang-core';
import type { ZodObject, ZodRawShape } from 'zod';
import { z } from 'zod';
import type { ElementNode, ParseResult, UiDocument } from './lang/document';
import { OPENUI_LANG_DIALECT, serializeDocument } from './lang/document';

export type { PromptOptions } from '@openuidev/lang-core';

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

/** @public A registered component library — the vocabulary a surface renders. */
export interface UiLibrary<N extends string = string> {
  dialect: string;
  components: ReadonlyMap<string, ComponentDefinition>;
  componentNames: readonly N[];
  /** The component named in the prompt's `root = X(...)` instruction. */
  readonly root: string | undefined;
  /** The underlying lang-core library (JSON schema, prompt, parser source). */
  readonly core: Library;
  /**
   * The generated component-library prompt appended to a step's instructions.
   * Defaults teach the full interactive language ($state bindings, Query and
   * Mutation, Action steps including @ToAssistant); pass lang-core
   * `PromptOptions` to override or extend (e.g. a `tools` list).
   */
  systemPrompt(options?: PromptOptions): string;
  /** The JSON Schema lang-core's parser uses for positional-to-named mapping. */
  toJSONSchema(): LibraryJSONSchema;
}

/** @public Options for `createLibrary`. */
export interface CreateLibraryOptions {
  dialect?: string;
  /**
   * Component the prompt's `root = X(...)` instruction names. Must be a
   * registered component. Defaults to the first definition, so the prompt
   * never instructs the model to call a component that does not exist.
   */
  root?: string;
}

/**
 * Rules appended to every generated prompt so the model contract is at least
 * as strong as the pre-lang-core prompt. lang-core only teaches Action steps
 * when a component prop is typed `ActionExpression`, which the renderer-free
 * bridge does not use, so the Action vocabulary is taught here.
 */
const NOETIC_PROMPT_RULES: readonly string[] = [
  'Interactive props accept an Action block: `Action([@Run(ref), @Set($var, value), @ToAssistant("message")])`. Steps run sequentially. Use `@ToAssistant` for buttons that send the assistant a message.',
  'When a tool can supply the data, fetch it with `Query()` instead of inventing values.',
];

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
  const root = options?.root ?? definitions[0]?.name;

  // Bridge each renderer-free definition into a lang-core component. lang-core
  // requires a description and props object; the `component` renderer is unused
  // on the server, so it is left undefined.
  const core = langCore.createLibrary({
    components: definitions.map((def) =>
      langCore.defineComponent({
        name: def.name,
        description: def.description ?? '',
        props: def.props ?? z.object({}),
        component: undefined,
      }),
    ),
    ...(root === undefined
      ? {}
      : {
          root,
        }),
  });

  return {
    dialect,
    components,
    componentNames: definitions.map((d) => d.name),
    root,
    core,
    systemPrompt: (promptOptions?: PromptOptions): string => {
      const { additionalRules = [], ...rest } = promptOptions ?? {};
      return core.prompt({
        // The pre-lang-core prompt always taught the full interactive
        // language, so both feature flags default on; callers can turn
        // either off through `rest`.
        toolCalls: true,
        bindings: true,
        ...rest,
        additionalRules: [
          ...NOETIC_PROMPT_RULES,
          ...additionalRules,
        ],
      });
    },
    toJSONSchema: () => core.toJSONSchema(),
  };
}

//#endregion

//#region Prop introspection

export interface PropSignature {
  name: string;
  /** Human-readable type rendered into diagnostics (`string`, `number`, …). */
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

//#region Validation

/** @public One problem found validating a document against a library. */
export interface UiValidationIssue {
  ref: string;
  component: string;
  message: string;
}

/** Map a lang-core structural parse error to a Noetic validation issue. */
function fromParseError(error: ValidationError): UiValidationIssue {
  const ref = error.statementId ?? '';
  switch (error.code) {
    case 'unknown-component':
      return {
        ref,
        component: error.component,
        message: `unknown component '${error.component}'`,
      };
    case 'excess-args':
      return {
        ref,
        component: error.component,
        message: `too many arguments: ${error.message}`,
      };
    case 'missing-required':
    case 'null-required':
      return {
        ref,
        component: error.component,
        message: `prop '${error.path.replace(/^\//, '')}' is required`,
      };
    default:
      return {
        ref,
        component: error.component,
        message: error.message,
      };
  }
}

/** Shared state for one validation walk: the library, dedupe, and null policy. */
interface ValidationWalk {
  library: UiLibrary;
  add: (issue: UiValidationIssue) => void;
  /**
   * True when the parsed program has unresolved references. lang-core drops an
   * unresolved ref to `null` in the output, which is indistinguishable from a
   * literal null, so null-value checks are suppressed to avoid flagging
   * cross-turn references (a partial re-render referencing statements that
   * live on the merged surface, not in this turn's document).
   */
  skipNullChecks: boolean;
}

/** A value that is statically checkable (old validator's `literal` args). */
function isPrimitiveLiteral(value: unknown): value is string | number | boolean | null {
  if (value === null) {
    return true;
  }
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/** Walk one resolved element, checking literal props and recursing into children. */
function walkElement(walk: ValidationWalk, node: ElementNode, ownerRef: string): void {
  const ref = node.statementId ?? ownerRef;
  const def = walk.library.components.get(node.typeName);
  if (def?.props) {
    for (const [name, value] of Object.entries(node.props)) {
      // Runtime expressions ($state, member access, operators) survive as AST
      // nodes; they resolve at render time and are skipped, same as before.
      if (langCore.isASTNode(value)) {
        continue;
      }
      // Only primitive literals are checked, matching the old validator:
      // arrays and objects may contain resolved child elements or dropped
      // refs, which the library's prop schemas do not describe.
      if (!isPrimitiveLiteral(value)) {
        continue;
      }
      if (value === null && walk.skipNullChecks) {
        continue;
      }
      const shape = def.props.shape[name];
      if (!shape) {
        continue;
      }
      const parsed = z.safeParse(shape, value);
      if (!parsed.success) {
        walk.add({
          ref,
          component: node.typeName,
          message: `prop '${name}' rejects ${JSON.stringify(value)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        });
      }
    }
  }
  for (const value of Object.values(node.props)) {
    findChildElements(value, (child) => walkElement(walk, child, ref));
  }
}

function isElementNode(value: unknown): value is ElementNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'element' &&
    'typeName' in value &&
    typeof value.typeName === 'string'
  );
}

/** Find resolved child elements nested in arrays and plain objects. */
function findChildElements(value: unknown, visit: (node: ElementNode) => void): void {
  if (langCore.isASTNode(value)) {
    return; // runtime expression, resolved later
  }
  if (isElementNode(value)) {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      findChildElements(item, visit);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) {
      findChildElements(nested, visit);
    }
  }
}

/**
 * Validate every component call in a document against the library: unknown
 * components, arity overflow, missing required props, and literal prop
 * mismatches. Dynamic args (refs, `$state`, nested calls) are skipped — they
 * resolve at render time.
 *
 * Coverage is whole-document, not just the tree reachable from `root`:
 * lang-core resolves and reports errors for the entry tree only, so each
 * statement it lists in `meta.orphaned` is re-resolved as its own root and
 * validated too. Cross-turn references (statements that live on the merged
 * surface, not in this document) are expected mid-conversation and are never
 * flagged; null checks are suppressed in any pass with unresolved refs, since
 * a dropped ref materializes as null.
 * @public
 */
export function validateDocument(library: UiLibrary, doc: UiDocument): UiValidationIssue[] {
  const source = serializeDocument(doc);
  if (source.trim().length === 0) {
    return [];
  }
  const parser = langCore.createParser(library.toJSONSchema());
  const seen = new Set<string>();
  const issues: UiValidationIssue[] = [];
  const add = (issue: UiValidationIssue): void => {
    const key = `${issue.ref} ${issue.component} ${issue.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    issues.push(issue);
  };

  const collect = (parsed: ParseResult, rootRef?: string): void => {
    const walk: ValidationWalk = {
      library,
      add,
      skipNullChecks: parsed.meta.unresolved.length > 0,
    };
    for (const error of parsed.meta.errors) {
      // A dropped unresolved ref materializes as null, so null-required is
      // unreliable whenever the pass has unresolved refs (see ValidationWalk).
      if (walk.skipNullChecks && error.code === 'null-required') {
        continue;
      }
      add(fromParseError(error));
    }
    if (parsed.root) {
      // In an orphan pass, lang-core stamps the synthetic entry's id onto the
      // resolved root element; restore the orphan's own ref for attribution.
      const rootNode =
        rootRef === undefined
          ? parsed.root
          : {
              ...parsed.root,
              statementId: rootRef,
            };
      walkElement(walk, rootNode, rootNode.statementId ?? '');
    }
  };

  const main = parser.parse(source);
  collect(main);
  // Statements unreachable from the entry tree get no errors from lang-core;
  // re-resolve each orphan as its own root (against the full source, so its
  // in-document references still resolve) and validate that tree as well.
  for (const orphanRef of main.meta.orphaned) {
    collect(parser.parse(`${source}\nroot = ${orphanRef}`), orphanRef);
  }
  return issues;
}

//#endregion
