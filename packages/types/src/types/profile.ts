/**
 * Connection profiles (spec 36): a shared, versioned vocabulary for one kind of
 * thing — its operations, the state worth reading, its events — plus vendor
 * extensions, the field helpers that mark refs, targets, sensitive fields,
 * blobs and receipts, the senses evidence comes from, and the declaration a
 * server publishes under `tools.noetic/profiles`.
 *
 * A profile is data: one definition types steps, validates documents,
 * generates JSON Schema, checks servers and drives verification.
 */

import { z } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';
import { isValidRange, parseSemVer } from '../util/semver';
import type { BlobRef, Receipt, Ref, Secret } from './connection';
import { BlobRefSchema, refSchemaOf, SecretSchema } from './connection';

//#region Senses

/**
 * @public
 * Where evidence comes from — OVP's evidence channels (OVP §3), renamed so they
 * do not collide with `Channel<T>` or a chat channel. Senses outside this list
 * are prefixed `x-`.
 */
export const Sense = {
  Ui: 'ui',
  Net: 'net',
  Log: 'log',
  Route: 'route',
  State: 'state',
  Signal: 'signal',
  Storage: 'storage',
  Time: 'time',
  Visual: 'visual',
} as const;

/** @public One of the nine named senses. */
export type Sense = (typeof Sense)[keyof typeof Sense];

/** @public A named sense or an `x-` extension sense. */
export type SenseId = Sense | `x-${string}`;

/** @public Whether a sense can be evidence about the action that produced it (OVP independence). */
export type SenseIndependence = 'independent' | 'actuation-derived';

/** @public What a sense's evidence is worth (OVP grade). */
export type SenseGrade = 'consequence' | 'presence' | 'context';

/** @public An OVP channel descriptor for one sense, as a server declares it. */
export interface SenseDescriptor {
  readonly independence: SenseIndependence;
  readonly grade: SenseGrade;
  readonly note?: string;
}

/** @public OVP's default descriptor for each named sense (`CHANNEL_DEFAULTS`). A server may declare a sense less trustworthy, never more. */
export const SenseDefaults: Readonly<Record<Sense, SenseDescriptor>> = {
  ui: {
    independence: 'actuation-derived',
    grade: 'presence',
  },
  net: {
    independence: 'independent',
    grade: 'consequence',
  },
  state: {
    independence: 'actuation-derived',
    grade: 'consequence',
  },
  signal: {
    independence: 'actuation-derived',
    grade: 'consequence',
  },
  log: {
    independence: 'independent',
    grade: 'context',
  },
  route: {
    independence: 'actuation-derived',
    grade: 'presence',
  },
  storage: {
    independence: 'actuation-derived',
    grade: 'consequence',
  },
  time: {
    independence: 'independent',
    grade: 'context',
  },
  visual: {
    independence: 'actuation-derived',
    grade: 'presence',
  },
};

const SENSE_RE = /^(ui|net|log|route|state|signal|storage|time|visual|x-[a-z0-9-]+)$/;

/** @public Whether `value` is a named sense or a well-formed `x-` sense. */
export function isSenseId(value: string): value is SenseId {
  return SENSE_RE.test(value);
}

/** @public Zod schema for a `SenseId`. */
export const SenseIdSchema: z.ZodType<SenseId> = z.union([
  z.enum([
    'ui',
    'net',
    'log',
    'route',
    'state',
    'signal',
    'storage',
    'time',
    'visual',
  ]),
  z.templateLiteral([
    'x-',
    z.string().regex(/^[a-z0-9-]+$/),
  ]),
]);

/** @public Zod schema for a `SenseDescriptor`. */
export const SenseDescriptorSchema: z.ZodType<SenseDescriptor> = z.object({
  independence: z.enum([
    'independent',
    'actuation-derived',
  ]),
  grade: z.enum([
    'consequence',
    'presence',
    'context',
  ]),
  note: z.string().optional(),
});

/**
 * @public
 * How connections of a kind may be driven again on resume — OVP's determinism
 * profile (OVP §10.4), field for field.
 */
export interface Determinism {
  /** Can the subject be returned to a known start? */
  readonly reset: 'none' | 'cheap' | 'costly';
  /** May steps 0..N-1 be re-driven to resume at N? */
  readonly replayPrefix: 'free' | 'costly' | 'unsafe';
  /** Is the clock ours? */
  readonly time: 'wall' | 'injectable' | 'stepped';
  /** Do two identical reads of an unchanged subject agree? */
  readonly observation: 'exact' | 'sampled';
  /** Does an action commit something that cannot be taken back? */
  readonly actions: 'reversible' | 'irreversible';
}

/** @public Zod schema for `Determinism`. */
export const DeterminismSchema: z.ZodType<Determinism> = z.object({
  reset: z.enum([
    'none',
    'cheap',
    'costly',
  ]),
  replayPrefix: z.enum([
    'free',
    'costly',
    'unsafe',
  ]),
  time: z.enum([
    'wall',
    'injectable',
    'stepped',
  ]),
  observation: z.enum([
    'exact',
    'sampled',
  ]),
  actions: z.enum([
    'reversible',
    'irreversible',
  ]),
});

/** @public When a read is shown to the model. */
export type LookMode = 'turn' | 'effect' | 'ask';

/** @public Whether a listener can resume an event stream. */
export type ReplayMode = 'durable' | 'live' | 'none';

//#endregion

//#region Field helpers

/** @public What a field helper marks a schema as. */
export type ProfileFieldMeta =
  | {
      readonly kind: 'ref';
      readonly refKind: string;
      readonly volatile: boolean;
      readonly public: boolean;
    }
  | {
      readonly kind: 'target';
      readonly refKind: string;
    }
  | {
      readonly kind: 'sensitive';
    }
  | {
      readonly kind: 'blob';
      readonly mimeTypes: ReadonlyArray<string>;
      /** Never rendered to the model (a stored session); stored with `sensitive: true`. */
      readonly sensitive?: boolean;
    }
  | {
      readonly kind: 'receipt';
    };

/** @public The registry the field helpers record their marks in. Read it with `profileFieldOf`. */
export const profileFieldRegistry = z.registry<ProfileFieldMeta>();

/**
 * @public
 * The mark a field helper put on `schema`, looking through `.optional()`,
 * `.nullable()` and `.default()`.
 */
export function profileFieldOf(schema: z.core.$ZodType): ProfileFieldMeta | undefined {
  let current: z.core.$ZodType = schema;
  for (let depth = 0; depth < 8; depth++) {
    const meta = profileFieldRegistry.get(current);
    if (meta) {
      return meta;
    }
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current.unwrap();
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** @public `ref()` options. */
export interface RefOptions {
  /** Dies with the screen or the connection's current life (elements, windows). */
  readonly volatile?: boolean;
  /** Can be typed by a person (a channel id); skips the thread check. */
  readonly public?: boolean;
}

/** @public An id this connection hands out, of `kind`. */
export function ref<const K extends string>(
  kind: K,
  options: RefOptions = {},
): z.ZodType<Ref<K>, Ref<K>> {
  const schema = refSchemaOf(kind);
  profileFieldRegistry.add(schema, {
    kind: 'ref',
    refKind: kind,
    volatile: options.volatile ?? false,
    public: options.public ?? false,
  });
  return schema;
}

/** @public A ref of `kind` or a locator string, resolved by the server to exactly one thing. */
export function target<const K extends string>(
  kind: K,
): z.ZodType<Ref<K> | string, Ref<K> | string> {
  const schema = z.union([
    refSchemaOf(kind),
    z.string().min(1),
  ]);
  profileFieldRegistry.add(schema, {
    kind: 'target',
    refKind: kind,
  });
  return schema;
}

/** @public A field a secret may fill; redacted wherever it is stored or reported. */
export function sensitive<S extends z.ZodType>(
  schema: S,
): z.ZodType<z.output<S> | Secret, z.input<S> | Secret> {
  const wrapped = z.union([
    schema,
    SecretSchema,
  ]);
  profileFieldRegistry.add(wrapped, {
    kind: 'sensitive',
  });
  return wrapped;
}

function mimeMatches(pattern: string, mimeType: string): boolean {
  if (pattern === '*/*' || pattern === mimeType) {
    return true;
  }
  if (pattern.endsWith('/*')) {
    return mimeType.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/**
 * @public
 * Binary content of one of `mimeTypes` (`'image/*'` allowed), carried as a blob
 * reference. `{ sensitive: true }` marks content never rendered to the model —
 * a stored session; it is stored with `sensitive: true` in the artifact store.
 */
export function blob(
  mimeTypes: ReadonlyArray<string>,
  options: {
    readonly sensitive?: boolean;
  } = {},
): z.ZodType<BlobRef, BlobRef> {
  const schema = BlobRefSchema.refine(
    (b) => mimeTypes.length === 0 || mimeTypes.some((p) => mimeMatches(p, b.$blob.mimeType)),
    {
      message: `Blob must be one of: ${mimeTypes.join(', ')}.`,
    },
  );
  profileFieldRegistry.add(schema, {
    kind: 'blob',
    mimeTypes: [
      ...mimeTypes,
    ],
    ...(options.sensitive
      ? {
          sensitive: true,
        }
      : {}),
  });
  return schema;
}

/** @public The receipt every `effects` operation returns: `{ actionId, cursor }`. */
export function receipt(): z.ZodType<Receipt, Receipt> {
  const schema = z.object({
    actionId: z.string().min(1),
    cursor: z.string().nullable(),
  });
  profileFieldRegistry.add(schema, {
    kind: 'receipt',
  });
  return schema;
}

//#endregion

//#region Definitions

/** @public One operation of a profile. */
export interface ProfileOperationDef {
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /** Every part is required unless `required: false`. */
  readonly required?: boolean;
  /** Shown to the model as its own tool by default. */
  readonly eager?: boolean;
  /** Changes something; the output includes a `receipt()`. */
  readonly effects?: boolean;
  /** A lasting effect; servers must honor idempotency keys. Implies `effects`. */
  readonly once?: boolean;
  /** Destructive; needs approval unless policy allows it. */
  readonly guarded?: boolean;
  readonly sense?: SenseId;
}

/** @public State worth reading. */
export interface ProfileReadDef {
  readonly description?: string;
  readonly schema: z.ZodType;
  readonly sense: SenseId;
  readonly look?: LookMode;
  readonly required?: boolean;
}

/** @public One event of a profile. */
export interface ProfileEventDef {
  readonly description?: string;
  readonly payload: z.ZodType;
  /** Server-side filter arguments. */
  readonly arguments?: z.ZodType;
  readonly sense: SenseId;
  readonly replay: ReplayMode;
  /** The payload field naming the event's natural thread. */
  readonly thread?: string;
  readonly required?: boolean;
}

/** @public What a pool accepts to create a fresh connection. */
export interface ProfileSetupDef {
  readonly schema: z.ZodType;
  /** Fields only the pool's own setup may set, never a workflow (a command, a path). */
  readonly hostOnly?: ReadonlyArray<string>;
}

/** @public A parent requirement: a bare range declares it; a `ProfileRange` also inherits its parts. */
export type ProfileParent = string | ProfileRange;

/** @public `defineProfile()`'s argument. */
export interface ProfileDefinition {
  /** One lowercase label. */
  readonly name: string;
  /** Semver; the major is part of the identity (`chat@1`). */
  readonly version: string;
  readonly description?: string;
  /** Parent profiles with ranges: `{ ui: ui.range('^1') }` (or `{ ui: '^1' }` to declare without inheriting). */
  readonly extends?: Readonly<Record<string, ProfileParent>>;
  readonly operations?: Readonly<Record<string, ProfileOperationDef>>;
  readonly reads?: Readonly<Record<string, ProfileReadDef>>;
  readonly events?: Readonly<Record<string, ProfileEventDef>>;
  readonly setup?: ProfileSetupDef;
  readonly determinism?: Determinism;
  /** Default descriptors for the senses this profile uses; required for `x-` senses. */
  readonly senses?: Readonly<Record<string, SenseDescriptor>>;
  /** The identity surface connections of this kind report (`'web'`, `'x-chat'`). */
  readonly surface?: string;
}

/** @public A profile pinned to a version range, e.g. `browser.range('^1.1')`. */
export interface ProfileRange<P extends AnyProfile = AnyProfile> {
  readonly kind: 'profile-range';
  readonly profile: P;
  readonly range: string;
}

/** @public A defined profile. */
export interface Profile<D extends ProfileDefinition = ProfileDefinition> {
  readonly kind: 'profile';
  readonly name: D['name'];
  readonly version: D['version'];
  readonly major: number;
  /** `<name>@<major>`, e.g. `chat@1`. */
  readonly id: string;
  readonly definition: D;
  /** Parent requirements by profile name, as ranges. */
  readonly parents: Readonly<Record<string, string>>;
  /** Own and inherited parts. */
  readonly operations: Readonly<Record<string, ProfileOperationDef>>;
  readonly reads: Readonly<Record<string, ProfileReadDef>>;
  readonly events: Readonly<Record<string, ProfileEventDef>>;
  /** The default range a handle requires: `^<version>`. */
  readonly defaultRange: string;
  range(range: string): ProfileRange<Profile<D>>;
}

/** @public Any profile. Every `Profile<D>` is assignable to it: its parameter is used only covariantly. */
export type AnyProfile = Profile<ProfileDefinition>;

/** @public An extension's addition to a profile operation or event: optional fields under `ext["<id>"]`. */
export interface ExtensionExtendDef {
  readonly input?: z.ZodObject;
  readonly output?: z.ZodObject;
  readonly payload?: z.ZodObject;
}

/** @public One operation an extension adds. */
export interface ExtensionOperationDef extends Omit<ProfileOperationDef, 'description'> {
  readonly description?: string;
}

/** @public `defineExtension()`'s argument. */
export interface ExtensionDefinition {
  /** Reverse domain plus a name, at least three labels: `com.slack.blocks`. */
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  /** Profiles it builds on, with ranges. */
  readonly requires?: Readonly<Record<string, string>>;
  readonly operations?: Readonly<Record<string, ExtensionOperationDef>>;
  readonly reads?: Readonly<Record<string, ProfileReadDef>>;
  readonly events?: Readonly<Record<string, ProfileEventDef>>;
  /** Optional fields added to profile operations and events. */
  readonly extend?: Readonly<Record<string, ExtensionExtendDef>>;
  readonly senses?: Readonly<Record<string, SenseDescriptor>>;
}

/** @public An extension pinned to a range. */
export interface ExtensionRange<E extends AnyExtension = AnyExtension> {
  readonly kind: 'extension-range';
  readonly extension: E;
  readonly range: string;
}

/** @public A defined extension. */
export interface Extension<D extends ExtensionDefinition = ExtensionDefinition> {
  readonly kind: 'extension';
  readonly id: D['id'];
  readonly version: D['version'];
  readonly major: number;
  readonly definition: D;
  readonly defaultRange: string;
  range(range: string): ExtensionRange<Extension<D>>;
}

/** @public Any extension. Every `Extension<D>` is assignable to it: its parameter is used only covariantly. */
export type AnyExtension = Extension<ExtensionDefinition>;

//#endregion

//#region Type helpers

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type PartsOf<D, Key extends 'operations' | 'reads' | 'events'> = D extends {
  readonly [K in Key]: infer R;
}
  ? R extends Readonly<Record<string, unknown>>
    ? R
    : Record<never, never>
  : Record<never, never>;

type InheritedParts<E, Key extends 'operations' | 'reads' | 'events'> = [
  E,
] extends [
  Readonly<Record<string, unknown>>,
]
  ? UnionToIntersection<
      {
        [K in keyof E]: E[K] extends ProfileRange<infer P>
          ? AllParts<P, Key>
          : Record<never, never>;
      }[keyof E]
    >
  : Record<never, never>;

type AllParts<P, Key extends 'operations' | 'reads' | 'events'> =
  P extends Profile<infer D>
    ? PartsOf<D, Key> & InheritedParts<D['extends'], Key>
    : Record<never, never>;

/** @public Every operation of a profile, own and inherited, by name. */
export type ProfileOperations<P> = AllParts<P, 'operations'>;

/** @public Every read of a profile, own and inherited, by name. */
export type ProfileReads<P> = AllParts<P, 'reads'>;

/** @public Every event of a profile, own and inherited, by name. */
export type ProfileEvents<P> = AllParts<P, 'events'>;

/** @public An operation name of `P`. */
export type OperationName<P> = keyof ProfileOperations<P> & string;

/** @public The argument type of operation `O` of `P`. */
export type OperationInput<P, O extends OperationName<P>> = ProfileOperations<P>[O] extends {
  readonly input: infer S extends z.ZodType;
}
  ? z.input<S>
  : never;

/** @public The result type of operation `O` of `P`. */
export type OperationOutput<P, O extends OperationName<P>> = ProfileOperations<P>[O] extends {
  readonly output: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

/** @public An event name of `P`. */
export type EventName<P> = keyof ProfileEvents<P> & string;

/** @public The payload type of event `E` of `P`. */
export type EventPayload<P, E extends EventName<P>> = ProfileEvents<P>[E] extends {
  readonly payload: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

/** @public A read name of `P`. */
export type ReadName<P> = keyof ProfileReads<P> & string;

/** @public The value type of read `R` of `P`. */
export type ReadValue<P, R extends ReadName<P>> = ProfileReads<P>[R] extends {
  readonly schema: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

//#endregion

//#region Validation helpers

const PROFILE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PART_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const EXTENSION_ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/;

function invalid(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message,
    hint,
  });
}

function requireVersion(owner: string, version: string): number {
  const parsed = parseSemVer(version);
  if (!parsed) {
    throw invalid(
      `${owner} version '${version}' is not semver.`,
      "Use 'major.minor.patch', e.g. '1.0.0'.",
    );
  }
  return parsed.major;
}

function requireRange(owner: string, range: string): void {
  if (!isValidRange(range)) {
    throw invalid(
      `${owner} range '${range}' is not a semver range.`,
      "Use a range such as '^1' or '^1.2'.",
    );
  }
}

function requirePartNames(
  owner: string,
  parts: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(parts ?? {})) {
    if (!PART_NAME_RE.test(name)) {
      throw invalid(
        `${owner} part '${name}' has characters MCP tool names cannot carry.`,
        'Use only letters, digits, _, - and . in names.',
      );
    }
  }
}

function requireSenses(
  owner: string,
  declared: Readonly<Record<string, SenseDescriptor>> | undefined,
  parts: ReadonlyArray<{
    sense?: SenseId;
  }>,
): void {
  for (const part of parts) {
    const sense = part.sense;
    if (sense === undefined) {
      continue;
    }
    if (!isSenseId(sense)) {
      throw invalid(
        `${owner} uses unknown sense '${sense}'.`,
        "Use a named sense or an 'x-' sense.",
      );
    }
    if (sense.startsWith('x-') && !declared?.[sense]) {
      throw invalid(
        `${owner} uses '${sense}' without declaring its independence and grade.`,
        `Add senses: { '${sense}': { independence, grade } }.`,
      );
    }
  }
}

function hasReceiptField(output: z.ZodType): boolean {
  if (!(output instanceof z.ZodObject)) {
    return false;
  }
  const field = output.shape.receipt;
  return field !== undefined && profileFieldOf(field)?.kind === 'receipt';
}

function requireOperationFlags(
  owner: string,
  ops: Readonly<Record<string, ExtensionOperationDef>> | undefined,
): void {
  for (const [name, op] of Object.entries(ops ?? {})) {
    if (op.once && !op.effects) {
      throw invalid(
        `${owner} operation '${name}' is 'once' without 'effects'.`,
        "A 'once' operation has a lasting effect; set effects: true.",
      );
    }
    if (op.effects && !hasReceiptField(op.output)) {
      throw invalid(
        `${owner} operation '${name}' has effects but its output has no receipt().`,
        'Every effects operation returns z.object({ …, receipt: receipt() }).',
      );
    }
  }
}

function mergeInherited<T>(
  owner: string,
  own: Readonly<Record<string, T>> | undefined,
  inherited: ReadonlyArray<Readonly<Record<string, T>>>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const parts of inherited) {
    Object.assign(merged, parts);
  }
  for (const [name, part] of Object.entries(own ?? {})) {
    if (Object.hasOwn(merged, name)) {
      throw invalid(
        `${owner} redefines inherited part '${name}'.`,
        'Parent parts are inherited unchanged; extend them with an extension instead.',
      );
    }
    merged[name] = part;
  }
  return merged;
}

//#endregion

//#region Public API

/**
 * @public
 * Defines a profile. Validates names, versions, ranges, flags and senses, and
 * resolves the parts inherited from parents given as `ProfileRange`s.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the definition is malformed.
 */
export function defineProfile<const D extends ProfileDefinition>(definition: D): Profile<D> {
  const owner = `Profile '${definition.name}'`;
  if (!PROFILE_NAME_RE.test(definition.name)) {
    throw invalid(
      `${owner} name must be one lowercase label.`,
      "Use a name such as 'browser' or 'chat'.",
    );
  }
  const major = requireVersion(owner, definition.version);
  requirePartNames(owner, definition.operations);
  requirePartNames(owner, definition.reads);
  requirePartNames(owner, definition.events);
  requireOperationFlags(owner, definition.operations);
  requireSenses(owner, definition.senses, [
    ...Object.values(definition.operations ?? {}),
    ...Object.values(definition.reads ?? {}),
    ...Object.values(definition.events ?? {}),
  ]);

  const parents: Record<string, string> = {};
  const inheritedFrom: AnyProfile[] = [];
  for (const [name, parent] of Object.entries(definition.extends ?? {})) {
    const range = typeof parent === 'string' ? parent : parent.range;
    requireRange(`${owner} parent '${name}'`, range);
    parents[name] = range;
    if (typeof parent === 'string') {
      continue;
    }
    if (parent.profile.name !== name) {
      throw invalid(
        `${owner} lists '${parent.profile.name}' under '${name}'.`,
        'Key each parent by its own profile name.',
      );
    }
    Object.assign(parents, parent.profile.parents);
    inheritedFrom.push(parent.profile);
  }

  const profile: Profile<D> = {
    kind: 'profile',
    name: definition.name,
    version: definition.version,
    major,
    id: `${definition.name}@${major}`,
    definition,
    parents,
    operations: mergeInherited(
      owner,
      definition.operations,
      inheritedFrom.map((p) => p.operations),
    ),
    reads: mergeInherited(
      owner,
      definition.reads,
      inheritedFrom.map((p) => p.reads),
    ),
    events: mergeInherited(
      owner,
      definition.events,
      inheritedFrom.map((p) => p.events),
    ),
    defaultRange: `^${definition.version}`,
    range(range: string): ProfileRange<Profile<D>> {
      requireRange(owner, range);
      return {
        kind: 'profile-range',
        profile,
        range,
      };
    },
  };
  return profile;
}

function requireNamespaced(
  owner: string,
  id: string,
  parts: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(parts ?? {})) {
    if (!name.startsWith(`${id}.`)) {
      throw invalid(
        `${owner} part '${name}' is not named under '${id}'.`,
        `Name everything an extension adds '${id}.<name>'.`,
      );
    }
  }
}

function requireOptionalFields(
  owner: string,
  target: string,
  schema: z.ZodObject | undefined,
): void {
  for (const [field, fieldSchema] of Object.entries(schema?.shape ?? {})) {
    if (!(fieldSchema instanceof z.ZodType) || !fieldSchema.safeParse(undefined).success) {
      throw invalid(
        `${owner} makes '${target}' field '${field}' required.`,
        'An extension may only add optional fields to a profile part.',
      );
    }
  }
}

/**
 * @public
 * Defines a vendor extension. Its id is a reverse domain plus a name (at least
 * three labels); everything it adds is named under its id; `extend` adds only
 * optional fields.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the definition is malformed.
 */
export function defineExtension<const D extends ExtensionDefinition>(definition: D): Extension<D> {
  const owner = `Extension '${definition.id}'`;
  if (!EXTENSION_ID_RE.test(definition.id)) {
    throw invalid(
      `${owner} id must be a reverse domain plus a name.`,
      "Use at least three lowercase labels, e.g. 'com.slack.blocks'.",
    );
  }
  const major = requireVersion(owner, definition.version);
  for (const [name, range] of Object.entries(definition.requires ?? {})) {
    requireRange(`${owner} requirement '${name}'`, range);
  }
  requirePartNames(owner, definition.operations);
  requirePartNames(owner, definition.reads);
  requirePartNames(owner, definition.events);
  requireNamespaced(owner, definition.id, definition.operations);
  requireNamespaced(owner, definition.id, definition.reads);
  requireNamespaced(owner, definition.id, definition.events);
  requireOperationFlags(owner, definition.operations);
  requireSenses(owner, definition.senses, [
    ...Object.values(definition.operations ?? {}),
    ...Object.values(definition.reads ?? {}),
    ...Object.values(definition.events ?? {}),
  ]);
  for (const [name, addition] of Object.entries(definition.extend ?? {})) {
    requireOptionalFields(owner, name, addition.input);
    requireOptionalFields(owner, name, addition.output);
    requireOptionalFields(owner, name, addition.payload);
  }
  const extension: Extension<D> = {
    kind: 'extension',
    id: definition.id,
    version: definition.version,
    major,
    definition,
    defaultRange: `^${definition.version}`,
    range(range: string): ExtensionRange<Extension<D>> {
      requireRange(owner, range);
      return {
        kind: 'extension-range',
        extension,
        range,
      };
    },
  };
  return extension;
}

/** @public A `profile@range` requirement string parsed, e.g. `browser@^1.2`. */
export interface ParsedProfileRequirement {
  readonly profile: string;
  readonly range: string;
}

/**
 * @public
 * Parses a JSON manifest's `profile` field (`'browser@^1.2'`).
 * @returns The profile and range, or `undefined` when malformed.
 */
export function parseProfileRequirement(text: string): ParsedProfileRequirement | undefined {
  const at = text.indexOf('@');
  if (at <= 0) {
    return undefined;
  }
  const profile = text.slice(0, at);
  const range = text.slice(at + 1);
  if (!PROFILE_NAME_RE.test(profile) || !isValidRange(range) || range.trim() === '') {
    return undefined;
  }
  return {
    profile,
    range,
  };
}

//#endregion

//#region Server declaration

/** @public What a server declares under `tools.noetic/profiles` in its MCP `extensions` capability. */
export interface ServerProfileDeclaration {
  /** Profile name → version; each with every parent, inside the child's range. */
  readonly profiles: Readonly<Record<string, string>>;
  readonly extensions?: Readonly<Record<string, string>>;
  /** Sense → OVP channel descriptor. */
  readonly senses?: Readonly<Record<string, SenseDescriptor>>;
  readonly determinism?: Determinism;
  /** JSON Schema of the setup the server accepts. */
  readonly setup?: Readonly<Record<string, unknown>>;
  /** Operation → an existing tool with fixed arguments merged in. */
  readonly aliases?: Readonly<
    Record<
      string,
      {
        readonly tool: string;
        readonly fixed?: Readonly<Record<string, unknown>>;
      }
    >
  >;
  /** When one server serves several connections. */
  readonly instances?: ReadonlyArray<{
    readonly id: string;
    readonly title?: string;
  }>;
}

const SEMVER_STRING = z.string().refine((v) => parseSemVer(v) !== undefined, {
  message: 'Expected a semver version.',
});

/** @public Zod schema for `ServerProfileDeclaration`. */
export const ServerProfileDeclarationSchema: z.ZodType<ServerProfileDeclaration> = z.object({
  profiles: z.record(z.string().regex(PROFILE_NAME_RE), SEMVER_STRING),
  extensions: z.record(z.string().regex(EXTENSION_ID_RE), SEMVER_STRING).optional(),
  senses: z.record(z.string().regex(SENSE_RE), SenseDescriptorSchema).optional(),
  determinism: DeterminismSchema.optional(),
  setup: z.record(z.string(), z.unknown()).optional(),
  aliases: z
    .record(
      z.string().regex(PART_NAME_RE),
      z.object({
        tool: z.string().regex(PART_NAME_RE),
        fixed: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  instances: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().optional(),
      }),
    )
    .optional(),
});

//#endregion
