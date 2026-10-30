/**
 * Capability discovery (spec 35 § The provider contract, spec 36 § Declaring
 * a server): reading the `tools.noetic/profiles` declaration, checking what
 * the server actually serves against it, and building the connection's
 * manifest.
 *
 * A server whose tools contradict its declaration is unavailable. What counts
 * as a contradiction: a malformed declaration; an alias onto a tool the server
 * does not serve; a sense declared more trustworthy than OVP's default
 * (OVP-CHAN-1); a determinism more forgiving than its profile's default; no
 * `noetic://identity`; a resettable determinism with no `noetic.reset`; and —
 * when the bridge was given the profile or extension definition — a parent
 * missing or outside the child's range, a required operation, read or event
 * not served, or a required input field the serving tool does not accept.
 *
 * A server with no declaration has no profile: every tool is an operation,
 * and it has no reads, events or senses.
 */

import type {
  AnyExtension,
  AnyProfile,
  ConnectionEventInfo,
  ConnectionManifest,
  ConnectionOperationInfo,
  ConnectionPartOrigin,
  ConnectionResourceInfo,
  Determinism,
  JsonSchemaObject,
  ProfileEventDef,
  ProfileOperationDef,
  ProfileReadDef,
  SenseDescriptor,
  SenseId,
  ServerProfileDeclaration,
} from '@noetic-tools/types';
import {
  isSenseId,
  PROFILES_CAPABILITY,
  parseSemVer,
  SenseDefaults,
  ServerProfileDeclarationSchema,
  satisfiesRange,
} from '@noetic-tools/types';
import { z } from 'zod';
import type { EventInfo, ResourceInfo, ToolInfo } from './wire';
import { COVERAGE_URI, IDENTITY_CHANGED_EVENT, IDENTITY_URI, UniversalTool } from './wire';

//#region Types

/** @public What the server serves, as discovery found it. */
export interface ServedParts {
  readonly tools: ReadonlyArray<ToolInfo>;
  readonly resources: ReadonlyArray<ResourceInfo>;
  readonly events: ReadonlyArray<EventInfo>;
}

/** @public The profile and extension definitions the bridge checks against. */
export interface Catalog {
  readonly profiles: ReadonlyArray<AnyProfile>;
  readonly extensions: ReadonlyArray<AnyExtension>;
}

/** @public How an operation reaches the server. */
export interface OperationRoute {
  readonly tool: string;
  readonly fixed: Readonly<Record<string, unknown>>;
}

/** @public A discovered connection shape. */
export interface Discovery {
  readonly manifest: ConnectionManifest;
  readonly declaration?: ServerProfileDeclaration;
  /** Operation name → the tool and fixed arguments that serve it. */
  readonly routes: ReadonlyMap<string, OperationRoute>;
  /** Read name → resource URI. */
  readonly readUris: ReadonlyMap<string, string>;
  /** Tool names of the universal parts the server serves. */
  readonly universal: ReadonlySet<string>;
  readonly hasCoverage: boolean;
}

/** @public Discovery's outcome: the shape, or why the server contradicts its declaration. */
export type DiscoveryOutcome =
  | {
      readonly ok: true;
      readonly discovery: Discovery;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface CatalogPart<T> {
  readonly def: T;
  readonly origin: ConnectionPartOrigin;
}

interface CatalogIndex {
  readonly operations: Map<
    string,
    CatalogPart<ProfileOperationDef | Omit<ProfileOperationDef, 'description'>>
  >;
  readonly reads: Map<string, CatalogPart<ProfileReadDef>>;
  readonly events: Map<string, CatalogPart<ProfileEventDef>>;
  readonly determinism?: Determinism;
}

//#endregion

//#region Trust orderings

const INDEPENDENCE_RANK: Readonly<Record<SenseDescriptor['independence'], number>> = {
  'actuation-derived': 0,
  independent: 1,
};

const GRADE_RANK: Readonly<Record<SenseDescriptor['grade'], number>> = {
  context: 0,
  presence: 1,
  consequence: 2,
};

const DETERMINISM_RANK: {
  readonly [K in keyof Determinism]: Readonly<Record<Determinism[K], number>>;
} = {
  reset: {
    none: 0,
    costly: 1,
    cheap: 2,
  },
  replayPrefix: {
    unsafe: 0,
    costly: 1,
    free: 2,
  },
  time: {
    wall: 0,
    injectable: 1,
    stepped: 2,
  },
  observation: {
    sampled: 0,
    exact: 1,
  },
  actions: {
    irreversible: 0,
    reversible: 1,
  },
};

const UNIVERSAL_TOOLS: ReadonlySet<string> = new Set(Object.values(UniversalTool));

//#endregion

//#region Helpers

function isNamedSense(sense: string): sense is keyof typeof SenseDefaults {
  return Object.hasOwn(SenseDefaults, sense);
}

/** @public Senses declared more trustworthy than OVP's defaults (OVP-CHAN-1). */
export function overTrustedSenses(senses: Readonly<Record<string, SenseDescriptor>>): string[] {
  const out: string[] = [];
  for (const [sense, declared] of Object.entries(senses)) {
    if (!isNamedSense(sense)) {
      continue;
    }
    const fallback = SenseDefaults[sense];
    if (
      INDEPENDENCE_RANK[declared.independence] > INDEPENDENCE_RANK[fallback.independence] ||
      GRADE_RANK[declared.grade] > GRADE_RANK[fallback.grade]
    ) {
      out.push(sense);
    }
  }
  return out;
}

/**
 * An `x-` sense a profile uses must be described by the server too, and no more
 * trustworthy than the profile's default (spec 36: "x- senses must declare
 * both"; a server may declare a sense less trustworthy, never more — OVP-CHAN-1).
 */
function xSenseProblem(
  defaults: Readonly<Record<string, SenseDescriptor>>,
  declared: Readonly<Record<string, SenseDescriptor>>,
): string | undefined {
  for (const [sense, fallback] of Object.entries(defaults)) {
    if (!sense.startsWith('x-')) {
      continue;
    }
    const given = declared[sense];
    if (given === undefined) {
      return `describes no '${sense}' sense`;
    }
    if (
      INDEPENDENCE_RANK[given.independence] > INDEPENDENCE_RANK[fallback.independence] ||
      GRADE_RANK[given.grade] > GRADE_RANK[fallback.grade]
    ) {
      return `declares sense '${sense}' more trustworthy than the profile's (OVP-CHAN-1)`;
    }
  }
  return undefined;
}

/** @public Determinism fields a server declares more forgiving than its profile's default. */
export function overForgivingDeterminism(declared: Determinism, fallback: Determinism): string[] {
  const out: string[] = [];
  const keys: ReadonlyArray<keyof Determinism> = [
    'reset',
    'replayPrefix',
    'time',
    'observation',
    'actions',
  ];
  for (const key of keys) {
    const ranks: Readonly<Record<string, number>> = DETERMINISM_RANK[key];
    if ((ranks[declared[key]] ?? 0) > (ranks[fallback[key]] ?? 0)) {
      out.push(key);
    }
  }
  return out;
}

function readDeclaration(capabilities: Readonly<Record<string, unknown>> | undefined):
  | {
      readonly found: false;
    }
  | {
      readonly found: true;
      readonly declaration?: ServerProfileDeclaration;
      readonly error?: string;
    } {
  const extensions = capabilities?.extensions;
  if (
    typeof extensions !== 'object' ||
    extensions === null ||
    !(PROFILES_CAPABILITY in extensions)
  ) {
    return {
      found: false,
    };
  }
  const parsed = ServerProfileDeclarationSchema.safeParse(
    Reflect.get(extensions, PROFILES_CAPABILITY),
  );
  if (!parsed.success) {
    return {
      found: true,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return {
    found: true,
    declaration: parsed.data,
  };
}

function toJsonSchema(schema: z.ZodType | undefined): JsonSchemaObject | undefined {
  if (schema === undefined) {
    return undefined;
  }
  try {
    return z.toJSONSchema(schema, {
      unrepresentable: 'any',
    });
  } catch {
    return undefined;
  }
}

/** The JSON Schema of a profile operation's input, as callers write it (extra fields allowed). */
function profileInputSchema(schema: z.ZodType | undefined): JsonSchemaObject | undefined {
  if (schema === undefined) {
    return undefined;
  }
  try {
    return z.toJSONSchema(schema, {
      unrepresentable: 'any',
      io: 'input',
    });
  } catch {
    return undefined;
  }
}

function isDeclared(
  declared: Readonly<Record<string, string>>,
  name: string,
  major: number,
): boolean {
  const version = declared[name];
  return version !== undefined && parseSemVer(version)?.major === major;
}

function addOwned<T>(
  target: Map<string, CatalogPart<T>>,
  parts: Readonly<Record<string, T>> | undefined,
  origin: ConnectionPartOrigin,
): void {
  for (const [name, def] of Object.entries(parts ?? {})) {
    target.set(name, {
      def,
      origin,
    });
  }
}

function addInherited<T>(
  target: Map<string, CatalogPart<T>>,
  parts: Readonly<Record<string, T>>,
  origin: ConnectionPartOrigin,
): void {
  for (const [name, def] of Object.entries(parts)) {
    if (!target.has(name)) {
      target.set(name, {
        def,
        origin,
      });
    }
  }
}

function indexCatalog(declaration: ServerProfileDeclaration, catalog: Catalog): CatalogIndex {
  const operations: CatalogIndex['operations'] = new Map();
  const reads: CatalogIndex['reads'] = new Map();
  const events: CatalogIndex['events'] = new Map();
  let determinism: Determinism | undefined;
  const declaredProfiles = catalog.profiles.filter((p) =>
    isDeclared(declaration.profiles, p.name, p.major),
  );
  for (const profile of declaredProfiles) {
    const origin = {
      profile: profile.name,
    };
    addOwned(operations, profile.definition.operations, origin);
    addOwned(reads, profile.definition.reads, origin);
    addOwned(events, profile.definition.events, origin);
    determinism = mostCautious(determinism, profile.definition.determinism);
  }
  for (const profile of declaredProfiles) {
    const origin = {
      profile: profile.name,
    };
    addInherited(operations, profile.operations, origin);
    addInherited(reads, profile.reads, origin);
    addInherited(events, profile.events, origin);
  }
  for (const extension of catalog.extensions) {
    if (!isDeclared(declaration.extensions ?? {}, extension.id, extension.major)) {
      continue;
    }
    const origin = {
      extension: extension.id,
    };
    addOwned(operations, extension.definition.operations, origin);
    addOwned(reads, extension.definition.reads, origin);
    addOwned(events, extension.definition.events, origin);
  }
  return {
    operations,
    reads,
    events,
    ...(determinism === undefined
      ? {}
      : {
          determinism,
        }),
  };
}

/** The field-by-field least forgiving of two determinisms; either alone when the other is absent. */
export function mostCautious(
  a: Determinism | undefined,
  b: Determinism | undefined,
): Determinism | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  // Field by field: each takes the less forgiving of the two (spec 36: never more forgiving).
  return {
    reset: lessForgiving('reset', a.reset, b.reset),
    replayPrefix: lessForgiving('replayPrefix', a.replayPrefix, b.replayPrefix),
    time: lessForgiving('time', a.time, b.time),
    observation: lessForgiving('observation', a.observation, b.observation),
    actions: lessForgiving('actions', a.actions, b.actions),
  };
}

function lessForgiving<K extends keyof Determinism>(
  key: K,
  a: Determinism[K],
  b: Determinism[K],
): Determinism[K] {
  const ranks: Readonly<Record<string, number>> = DETERMINISM_RANK[key];
  return (ranks[a] ?? 0) <= (ranks[b] ?? 0) ? a : b;
}

function requiredInputFields(input: z.ZodType): string[] {
  if (!(input instanceof z.ZodObject)) {
    return [];
  }
  return Object.entries(input.shape)
    .filter(([, field]) => field instanceof z.ZodType && !field.safeParse(undefined).success)
    .map(([name]) => name);
}

function schemaProperties(schema: JsonSchemaObject): ReadonlySet<string> {
  const props = schema.properties;
  if (typeof props !== 'object' || props === null) {
    return new Set();
  }
  return new Set(Object.keys(props));
}

function schemaWithoutFixed(
  schema: JsonSchemaObject,
  fixed: Readonly<Record<string, unknown>>,
): JsonSchemaObject {
  const fixedNames = Object.keys(fixed);
  if (fixedNames.length === 0) {
    return schema;
  }
  const props =
    typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {};
  const kept = Object.fromEntries(
    Object.entries(props).filter(([name]) => !fixedNames.includes(name)),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === 'string' && !fixedNames.includes(name))
    : undefined;
  return {
    ...schema,
    properties: kept,
    ...(required === undefined
      ? {}
      : {
          required,
        }),
  };
}

function prefixOrigin(name: string, declaration: ServerProfileDeclaration): ConnectionPartOrigin {
  const extension = Object.keys(declaration.extensions ?? {}).find((id) =>
    name.startsWith(`${id}.`),
  );
  if (extension !== undefined) {
    return {
      extension,
    };
  }
  const profile = Object.keys(declaration.profiles).find((p) => name.startsWith(`${p}.`));
  if (profile !== undefined) {
    return {
      profile,
    };
  }
  return {};
}

function senseOf(value: string | undefined): SenseId | undefined {
  return value !== undefined && isSenseId(value) ? value : undefined;
}

//#endregion

//#region Checks

interface CheckContext {
  readonly declaration: ServerProfileDeclaration;
  readonly catalog: Catalog;
  readonly routes: ReadonlyMap<string, OperationRoute>;
  readonly served: ServedParts;
  readonly toolsByName: ReadonlyMap<string, ToolInfo>;
  readonly determinism: Determinism | undefined;
}

interface ServedIndex {
  readonly routes: ReadonlyMap<string, OperationRoute>;
  readonly toolsByName: ReadonlyMap<string, ToolInfo>;
  readonly resourceNames: ReadonlySet<string>;
  readonly events: ReadonlyMap<string, EventInfo>;
}

interface RequiredParts {
  readonly operations: Readonly<Record<string, Omit<ProfileOperationDef, 'description'>>>;
  readonly reads: Readonly<Record<string, ProfileReadDef>>;
  readonly events: Readonly<Record<string, ProfileEventDef>>;
}

function checkCatalogProfiles(ctx: CheckContext): string | undefined {
  const { declaration, catalog } = ctx;
  const servedIndex: ServedIndex = {
    routes: ctx.routes,
    toolsByName: ctx.toolsByName,
    resourceNames: new Set(ctx.served.resources.map((r) => r.name)),
    events: new Map(
      ctx.served.events.map((e) => [
        e.name,
        e,
      ]),
    ),
  };
  for (const profile of catalog.profiles) {
    if (!isDeclared(declaration.profiles, profile.name, profile.major)) {
      continue;
    }
    for (const [parent, range] of Object.entries(profile.parents)) {
      const version = declaration.profiles[parent];
      if (version === undefined || !satisfiesRange(version, range)) {
        return `declares ${profile.id} without its parent ${parent}@${range}`;
      }
    }
    const missing = missingParts(profile, servedIndex);
    if (missing !== undefined) {
      return `declares ${profile.id} but ${missing}`;
    }
    const senses = xSenseProblem(profile.definition.senses ?? {}, declaration.senses ?? {});
    if (senses !== undefined) {
      return `declares ${profile.id} but ${senses}`;
    }
  }
  for (const extension of catalog.extensions) {
    if (!isDeclared(declaration.extensions ?? {}, extension.id, extension.major)) {
      continue;
    }
    const missing = missingParts(
      {
        operations: extension.definition.operations ?? {},
        reads: extension.definition.reads ?? {},
        events: extension.definition.events ?? {},
      },
      servedIndex,
    );
    if (missing !== undefined) {
      return `declares ${extension.id} but ${missing}`;
    }
  }
  return undefined;
}

function missingParts(parts: RequiredParts, served: ServedIndex): string | undefined {
  for (const [name, op] of Object.entries(parts.operations)) {
    if (op.required === false) {
      continue;
    }
    const route = served.routes.get(name);
    const tool = route === undefined ? undefined : served.toolsByName.get(route.tool);
    if (route === undefined || tool === undefined) {
      return `does not serve required operation '${name}'`;
    }
    const accepted = schemaProperties(tool.inputSchema);
    const field = requiredInputFields(op.input).find(
      (f) => !accepted.has(f) && !Object.hasOwn(route.fixed, f),
    );
    if (field !== undefined) {
      return `its tool '${route.tool}' does not accept required field '${field}' of '${name}'`;
    }
  }
  for (const [name, read] of Object.entries(parts.reads)) {
    if (read.required !== false && !served.resourceNames.has(name)) {
      return `does not serve required read '${name}'`;
    }
  }
  for (const [name, event] of Object.entries(parts.events)) {
    const servedEvent = served.events.get(name);
    if (event.required !== false && servedEvent === undefined) {
      return `does not serve required event '${name}'`;
    }
    const contradiction = servedEvent && eventContradiction(name, event, servedEvent);
    if (contradiction) {
      return contradiction;
    }
  }
  return undefined;
}

/** How much of an event stream survives a reconnect: a weaker replay is a breaking change (spec 36 § Versioning). */
const REPLAY_RANK: Readonly<Record<'durable' | 'live' | 'none', number>> = {
  durable: 2,
  live: 1,
  none: 0,
};

/**
 * What a server says of an event that contradicts its profile: a weaker
 * replay, or another sense. A server that says nothing takes the profile's.
 */
function eventContradiction(
  name: string,
  def: ProfileEventDef,
  served: EventInfo,
): string | undefined {
  if (
    served.replay !== undefined &&
    def.replay !== undefined &&
    REPLAY_RANK[served.replay] < REPLAY_RANK[def.replay]
  ) {
    return `serves event '${name}' with replay '${served.replay}', weaker than the profile's '${def.replay}'`;
  }
  const sense = senseOf(served.sense);
  if (sense !== undefined && def.sense !== undefined && sense !== def.sense) {
    return `serves event '${name}' on sense '${sense}', not the profile's '${def.sense}'`;
  }
  return undefined;
}

function checkUniversal(ctx: CheckContext): string | undefined {
  const { declaration, determinism, served, toolsByName } = ctx;
  if (!served.resources.some((r) => r.uri === IDENTITY_URI)) {
    return `serves no ${IDENTITY_URI}`;
  }
  if (!served.events.some((e) => e.name === IDENTITY_CHANGED_EVENT)) {
    return `serves no ${IDENTITY_CHANGED_EVENT} event`;
  }
  if (
    determinism !== undefined &&
    determinism.reset !== 'none' &&
    !toolsByName.has(UniversalTool.Reset)
  ) {
    return `declares reset '${determinism.reset}' but serves no ${UniversalTool.Reset}`;
  }
  const overTrusted = overTrustedSenses(declaration.senses ?? {});
  if (overTrusted.length > 0) {
    return `declares sense ${overTrusted.join(', ')} more trustworthy than OVP allows (OVP-CHAN-1)`;
  }
  return undefined;
}

//#endregion

//#region Manifest

interface OperationSource {
  readonly name: string;
  readonly tool: ToolInfo;
  readonly route: OperationRoute;
  readonly part:
    | CatalogPart<
        Omit<ProfileOperationDef, 'description'> & {
          readonly description?: string;
        }
      >
    | undefined;
}

function operationInfo(
  source: OperationSource,
  declaration: ServerProfileDeclaration,
): ConnectionOperationInfo {
  const { name, tool, route, part } = source;
  const def = part?.def;
  const description = def?.description ?? tool.description;
  return {
    name,
    ...(description === undefined
      ? {}
      : {
          description,
        }),
    // A profile operation's arguments are the profile's: its `sensitive()` fields
    // accept `{ $secret }` and its refs are typed, whatever the tool publishes.
    inputSchema:
      profileInputSchema(def?.input) ?? schemaWithoutFixed(tool.inputSchema, route.fixed),
    ...(tool.outputSchema === undefined
      ? {}
      : {
          outputSchema: tool.outputSchema,
        }),
    ...(def?.eager === undefined
      ? {}
      : {
          eager: def.eager,
        }),
    ...(def?.effects === undefined
      ? {}
      : {
          effects: def.effects,
        }),
    ...(def?.once === undefined
      ? {}
      : {
          once: def.once,
        }),
    ...(def?.guarded === undefined
      ? {}
      : {
          guarded: def.guarded,
        }),
    ...(def?.sense === undefined
      ? {}
      : {
          sense: def.sense,
        }),
    ...(part?.origin ?? prefixOrigin(name, declaration)),
  };
}

function resourceInfo(
  resource: ResourceInfo,
  part: CatalogPart<ProfileReadDef> | undefined,
  declaration: ServerProfileDeclaration,
): ConnectionResourceInfo {
  const description = part?.def.description ?? resource.description;
  const schema = toJsonSchema(part?.def.schema);
  return {
    name: resource.name,
    ...(description === undefined
      ? {}
      : {
          description,
        }),
    ...(schema === undefined
      ? {}
      : {
          schema,
        }),
    ...(part === undefined
      ? {}
      : {
          sense: part.def.sense,
        }),
    ...(part?.def.look === undefined
      ? {}
      : {
          look: part.def.look,
        }),
    ...(part?.origin ?? prefixOrigin(resource.name, declaration)),
  };
}

function eventInfo(
  event: EventInfo,
  part: CatalogPart<ProfileEventDef> | undefined,
  declaration: ServerProfileDeclaration,
): ConnectionEventInfo {
  const description = part?.def.description ?? event.description;
  const sense = part?.def.sense ?? senseOf(event.sense);
  const thread = part?.def.thread ?? event.thread;
  const payloadSchema = event.payloadSchema ?? toJsonSchema(part?.def.payload);
  const argumentsSchema = event.argumentsSchema ?? toJsonSchema(part?.def.arguments);
  return {
    name: event.name,
    replay: part?.def.replay ?? event.replay ?? 'none',
    ...(description === undefined
      ? {}
      : {
          description,
        }),
    ...(payloadSchema === undefined
      ? {}
      : {
          payloadSchema,
        }),
    ...(argumentsSchema === undefined
      ? {}
      : {
          argumentsSchema,
        }),
    ...(sense === undefined
      ? {}
      : {
          sense,
        }),
    ...(thread === undefined
      ? {}
      : {
          thread,
        }),
    ...(part?.origin ?? prefixOrigin(event.name, declaration)),
  };
}

function manifestSenses(
  declared: Readonly<Record<string, SenseDescriptor>>,
  used: ReadonlyArray<SenseId | undefined>,
): Record<string, SenseDescriptor> {
  const senses: Record<string, SenseDescriptor> = {
    ...declared,
  };
  for (const sense of used) {
    if (sense === undefined || Object.hasOwn(senses, sense) || !isNamedSense(sense)) {
      continue;
    }
    senses[sense] = SenseDefaults[sense];
  }
  return senses;
}

function buildRoutes(
  declaration: ServerProfileDeclaration,
  tools: ReadonlyArray<ToolInfo>,
): Map<string, OperationRoute> {
  const routes = new Map<string, OperationRoute>();
  for (const tool of tools) {
    if (UNIVERSAL_TOOLS.has(tool.name)) {
      continue;
    }
    routes.set(tool.name, {
      tool: tool.name,
      fixed: {},
    });
  }
  for (const [op, alias] of Object.entries(declaration.aliases ?? {})) {
    routes.set(op, {
      tool: alias.tool,
      fixed: alias.fixed ?? {},
    });
  }
  return routes;
}

/**
 * A tool an alias maps a profile operation onto stays callable under its own
 * name, but never with fewer protections than the operations aliased to it: it
 * takes on their `effects`, `once` and `guarded`, so the raw name is no way
 * around a guarded operation's approval (spec 36 § Declaring a server).
 */
function guardAliasTargets(
  operations: Record<string, ConnectionOperationInfo>,
  routes: ReadonlyMap<string, OperationRoute>,
  index: CatalogIndex,
): void {
  for (const [name, route] of routes) {
    const raw = operations[route.tool];
    if (name === route.tool || raw === undefined || index.operations.has(route.tool)) {
      continue;
    }
    const aliased = operations[name];
    if (aliased === undefined) {
      continue;
    }
    operations[route.tool] = {
      ...raw,
      ...(aliased.effects || raw.effects
        ? {
            effects: true,
          }
        : {}),
      ...(aliased.once || raw.once
        ? {
            once: true,
          }
        : {}),
      ...(aliased.guarded || raw.guarded
        ? {
            guarded: true,
          }
        : {}),
    };
  }
}

function profileLess(served: ServedParts): Discovery {
  const operations: Record<string, ConnectionOperationInfo> = {};
  const routes = new Map<string, OperationRoute>();
  for (const tool of served.tools) {
    operations[tool.name] = {
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : {
            description: tool.description,
          }),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined
        ? {}
        : {
            outputSchema: tool.outputSchema,
          }),
    };
    routes.set(tool.name, {
      tool: tool.name,
      fixed: {},
    });
  }
  return {
    manifest: {
      profiles: {},
      extensions: {},
      operations,
      resources: {},
      events: {},
      senses: {},
    },
    routes,
    readUris: new Map(),
    universal: new Set(),
    hasCoverage: false,
  };
}

function declared(
  declaration: ServerProfileDeclaration,
  served: ServedParts,
  catalog: Catalog,
): DiscoveryOutcome {
  const toolsByName = new Map(
    served.tools.map((tool) => [
      tool.name,
      tool,
    ]),
  );
  const routes = buildRoutes(declaration, served.tools);
  for (const [op, route] of routes) {
    if (!toolsByName.has(route.tool)) {
      return {
        ok: false,
        reason: `aliases '${op}' to '${route.tool}', which it does not serve`,
      };
    }
  }
  const index = indexCatalog(declaration, catalog);
  const determinism = declaration.determinism ?? index.determinism;
  if (declaration.determinism !== undefined && index.determinism !== undefined) {
    const looser = overForgivingDeterminism(declaration.determinism, index.determinism);
    if (looser.length > 0) {
      return {
        ok: false,
        reason: `declares determinism ${looser.join(', ')} more forgiving than its profile allows`,
      };
    }
  }
  const ctx: CheckContext = {
    declaration,
    catalog,
    routes,
    served,
    toolsByName,
    determinism,
  };
  const failure = checkUniversal(ctx) ?? checkCatalogProfiles(ctx);
  if (failure !== undefined) {
    return {
      ok: false,
      reason: failure,
    };
  }

  const operations: Record<string, ConnectionOperationInfo> = {};
  for (const [name, route] of routes) {
    const tool = toolsByName.get(route.tool);
    if (tool !== undefined) {
      operations[name] = operationInfo(
        {
          name,
          tool,
          route,
          part: index.operations.get(name),
        },
        declaration,
      );
    }
  }
  guardAliasTargets(operations, routes, index);
  const resources: Record<string, ConnectionResourceInfo> = {};
  const readUris = new Map<string, string>();
  for (const resource of served.resources) {
    if (resource.uri === IDENTITY_URI || resource.uri.startsWith(COVERAGE_URI)) {
      continue;
    }
    resources[resource.name] = resourceInfo(resource, index.reads.get(resource.name), declaration);
    readUris.set(resource.name, resource.uri);
  }
  const events: Record<string, ConnectionEventInfo> = {};
  for (const event of served.events) {
    if (event.name === IDENTITY_CHANGED_EVENT) {
      continue;
    }
    events[event.name] = eventInfo(event, index.events.get(event.name), declaration);
  }
  const senses = manifestSenses(declaration.senses ?? {}, [
    ...Object.values(operations).map((o) => o.sense),
    ...Object.values(resources).map((r) => r.sense),
    ...Object.values(events).map((e) => e.sense),
  ]);
  return {
    ok: true,
    discovery: {
      manifest: {
        profiles: declaration.profiles,
        extensions: declaration.extensions ?? {},
        operations,
        resources,
        events,
        senses,
        ...(determinism === undefined
          ? {}
          : {
              determinism,
            }),
        ...(declaration.setup === undefined
          ? {}
          : {
              setup: declaration.setup,
            }),
      },
      declaration,
      routes,
      readUris,
      universal: new Set(
        served.tools.map((t) => t.name).filter((name) => UNIVERSAL_TOOLS.has(name)),
      ),
      hasCoverage: served.resources.some((r) => r.uri.startsWith(COVERAGE_URI)),
    },
  };
}

//#endregion

//#region Public API

/** @public Whether the server's capabilities carry a `tools.noetic/profiles` declaration. */
export function hasDeclaration(
  capabilities: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return readDeclaration(capabilities).found;
}

/**
 * @public
 * Reads the declaration from the server's capabilities, checks the served
 * parts against it (and against `catalog` where it has the definitions), and
 * builds the manifest.
 */
export function discover(
  capabilities: Readonly<Record<string, unknown>> | undefined,
  served: ServedParts,
  catalog: Catalog,
): DiscoveryOutcome {
  const read = readDeclaration(capabilities);
  if (!read.found) {
    return {
      ok: true,
      discovery: profileLess(served),
    };
  }
  if (read.declaration === undefined) {
    return {
      ok: false,
      reason: `has a malformed ${PROFILES_CAPABILITY} declaration (${read.error ?? 'unknown'})`,
    };
  }
  return declared(read.declaration, served, catalog);
}

//#endregion
