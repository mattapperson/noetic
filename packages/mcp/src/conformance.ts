/**
 * @noetic-tools/mcp/conformance — `checkConformance()` runs a profile's
 * scenarios against a server (spec 36 § Conformance).
 *
 * A **driver**, written by the server's author, causes what the server cannot:
 * arguments that act on the subject as it is, an independent confirmation
 * that an action happened, an ambiguous locator, a replaced subject, a claim
 * about a healthy subject. A scenario the driver cannot set up scores
 * `absent`, never a pass, so a report passes only when every scenario passed.
 *
 * Scenarios, in order: the declaration against what the server serves
 * (profile, parents, required operations, reads, events, extensions, senses);
 * the identity and its change on replacement; refusals (`malformed`,
 * `undeclared`, `ambiguous`); every `effects` operation's receipt and its
 * confirmation through an independent sense; `once` replay and conflict; one
 * healthy claim proved `yes` (OVP-CONF-2); sensitive fields masked on screen;
 * summaries in the § Senses formats. The report names each failure with the
 * profile part it comes from, and the OVP conformance level the declared
 * senses reach.
 */

import type {
  AnyExtension,
  AnyProfile,
  ArtifactStore,
  CallOutcome,
  CallResult,
  Connection,
  ConnectionIdentity,
  ConnectionProvider,
  ProfileOperationDef,
  Receipt,
} from '@noetic-tools/types';
import {
  isConnectionProvider,
  profileFieldOf,
  ReceiptSchema,
  satisfiesRange,
} from '@noetic-tools/types';
import { z } from 'zod';
import type { McpConfig } from './config';
import { McpConnection } from './connection';
import { createMemoryArtifactStore } from './memory-artifacts';
import { mcp } from './provider';

//#region Types

/** @public What a driver is handed. */
export interface ConformanceContext {
  readonly connection: Connection;
  readonly signal: AbortSignal;
  readonly artifacts: ArtifactStore;
}

/** @public An operation call a driver sets up. */
export interface ConformanceCall {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** @public An OVP verdict, as a driver reports a healthy claim's. */
export type ConformanceVerdict = 'yes' | 'no' | 'unknown' | 'no-fault';

/** @public The server author's half of conformance: everything the server cannot cause itself. */
export interface ConformanceDriver {
  /** Arguments that exercise `op` on the subject as it is now; `undefined` when it cannot be set up. */
  sample?(
    op: string,
    ctx: ConformanceContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Different arguments for `op`, to check a `once` key is refused with `conflict` when reused. */
  alternate?(
    op: string,
    ctx: ConformanceContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Confirms through an independent sense that the action behind `receipt` happened. */
  confirm?(op: string, receipt: Receipt, ctx: ConformanceContext): Promise<boolean | undefined>;
  /** A call whose locator matches several targets. */
  ambiguous?(ctx: ConformanceContext): Promise<ConformanceCall | undefined>;
  /** Replaces the subject (restarts the app, resets the device); `false` when it cannot. */
  replace?(ctx: ConformanceContext): Promise<boolean>;
  /** Evaluates one real claim against a healthy subject and returns its OVP verdict. */
  healthyClaim?(ctx: ConformanceContext): Promise<ConformanceVerdict | undefined>;
  /** Whether a sensitive field's value is masked on screen after it was filled. */
  masked?(ctx: ConformanceContext): Promise<boolean | undefined>;
  /** Summaries the server produced, to check against the § Senses formats. */
  summaries?(ctx: ConformanceContext): Promise<
    | ReadonlyArray<{
        readonly sense: string;
        readonly summary: string;
      }>
    | undefined
  >;
}

/** @public One scenario's outcome. */
export type ConformanceStatus = 'pass' | 'fail' | 'absent';

/** @public One scenario's result, naming the profile part it checks. */
export interface ConformanceResult {
  readonly id: string;
  readonly part: string;
  readonly status: ConformanceStatus;
  readonly message: string;
}

/** @public The OVP conformance level the declared senses reach. */
export type OvpConformanceLevel = 'none' | 'effect' | 'in-realm' | 'surface';

/** @public A conformance report. */
export interface ConformanceReport {
  /** `<name>@<major>`. */
  readonly profile: string;
  readonly identity?: ConnectionIdentity;
  /** Every scenario passed (an `absent` one is not a pass). */
  readonly passed: boolean;
  readonly level: OvpConformanceLevel;
  readonly results: ReadonlyArray<ConformanceResult>;
}

/** @public `checkConformance()`'s argument. */
export interface CheckConformanceOptions {
  /** An `mcp()` configuration, or any connection provider. */
  readonly server: McpConfig | ConnectionProvider;
  readonly profile: AnyProfile;
  readonly extensions?: ReadonlyArray<AnyExtension>;
  readonly driver?: ConformanceDriver;
  readonly signal?: AbortSignal;
  readonly artifacts?: ArtifactStore;
  /** How long to wait for an identity change after a replacement. Default 5e3 ms. */
  readonly identityTimeoutMs?: number;
}

interface RunState {
  readonly options: CheckConformanceOptions;
  readonly connection: Connection;
  readonly ctx: ConformanceContext;
  readonly results: ConformanceResult[];
  readonly driver: ConformanceDriver;
}

//#endregion

//#region Sense summaries

/** @public The § Senses summary format of each named sense. */
export const SENSE_SUMMARY_FORMATS: Readonly<Record<string, RegExp>> = {
  ui: /^[a-z][a-z0-9-]*( "(?:[^"\\]|\\.)*")?$/,
  net: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) \S+ [1-5]\d\d$/,
  log: /^(error|warn|info|debug|log|trace) \S.*$/,
  route: /^\/\S*$/,
  state: /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/,
  signal: /^[A-Za-z0-9_.:-]+$/,
  storage: /^[a-z][a-z-]* \S.*$/,
  time: /^(settled|in-flight \S+)$/,
  visual: /^capture$/,
};

/** @public Whether `summary` is in `sense`'s § Senses format (`x-` senses are not checked). */
export function matchesSenseSummary(sense: string, summary: string): boolean {
  const format = SENSE_SUMMARY_FORMATS[sense];
  return format === undefined ? sense.startsWith('x-') : format.test(summary);
}

/** @public The OVP conformance level a set of senses reaches. */
export function conformanceLevel(senses: Iterable<string>): OvpConformanceLevel {
  const have = new Set(senses);
  const all = (names: ReadonlyArray<string>): boolean => names.every((name) => have.has(name));
  if (
    !all([
      'net',
      'log',
    ])
  ) {
    return 'none';
  }
  if (
    !all([
      'state',
      'signal',
    ])
  ) {
    return 'effect';
  }
  return have.has('ui') ? 'surface' : 'in-realm';
}

//#endregion

//#region Helpers

function record(state: RunState, result: ConformanceResult): void {
  state.results.push(result);
}

function outcome(
  status: ConformanceStatus,
): (id: string, part: string, message: string) => ConformanceResult {
  return (id, part, message) => ({
    id,
    part,
    status,
    message,
  });
}

const pass = outcome('pass');
const fail = outcome('fail');
const absent = outcome('absent');

function parentsOf(profile: AnyProfile): AnyProfile[] {
  const out: AnyProfile[] = [];
  for (const parent of Object.values(profile.definition.extends ?? {})) {
    if (typeof parent === 'string') {
      continue;
    }
    out.push(parent.profile, ...parentsOf(parent.profile));
  }
  return out;
}

function requiredFields(input: z.ZodType): string[] {
  if (!(input instanceof z.ZodObject)) {
    return [];
  }
  return Object.entries(input.shape)
    .filter(([, field]) => field instanceof z.ZodType && !field.safeParse(undefined).success)
    .map(([name]) => name);
}

function hasSensitiveField(op: ProfileOperationDef): boolean {
  if (!(op.input instanceof z.ZodObject)) {
    return false;
  }
  return Object.values(op.input.shape).some(
    (field) => field instanceof z.ZodType && profileFieldOf(field)?.kind === 'sensitive',
  );
}

function key(prefix: string): string {
  return `conformance:${prefix}:${crypto.randomUUID()}`;
}

async function settle(
  connection: Connection,
  call: CallResult,
  signal: AbortSignal,
): Promise<CallOutcome> {
  if (call.status !== 'task') {
    return call;
  }
  return connection.tasks.result(call.taskId, {
    signal,
  });
}

async function callOp(
  state: RunState,
  call: ConformanceCall & {
    readonly idempotencyKey?: string;
  },
): Promise<CallOutcome> {
  // The runner stands in for a harness whose approver allows every guarded operation.
  const guarded =
    state.options.profile.operations[call.op]?.guarded === true ||
    state.connection.manifest.operations[call.op]?.guarded === true;
  const first = await state.connection.call(call.op, call.args, {
    signal: state.ctx.signal,
    idempotencyKey: call.idempotencyKey ?? key(call.op),
    ...(guarded
      ? {
          confirmed: true,
        }
      : {}),
  });
  return settle(state.connection, first, state.ctx.signal);
}

function receiptOf(output: unknown): Receipt | undefined {
  if (typeof output !== 'object' || output === null || !('receipt' in output)) {
    return undefined;
  }
  const parsed = ReceiptSchema.safeParse(output.receipt);
  return parsed.success ? parsed.data : undefined;
}

function presentOperations(state: RunState): Array<
  [
    string,
    ProfileOperationDef,
  ]
> {
  const offered = state.connection.manifest.operations;
  return Object.entries(state.options.profile.operations).filter(([name]) =>
    Object.hasOwn(offered, name),
  );
}

//#endregion

//#region Declaration scenarios

function checkDeclaration(state: RunState): void {
  const { profile } = state.options;
  const manifest = state.connection.manifest;
  const declared = manifest.profiles[profile.name];
  const majorRange = `^${profile.major}.0.0`;
  record(
    state,
    declared !== undefined && satisfiesRange(declared, majorRange)
      ? pass('declaration.profile', profile.id, `declares ${profile.name} ${declared}`)
      : fail(
          'declaration.profile',
          profile.id,
          `does not declare ${profile.name} inside ${majorRange} (declares ${declared ?? 'nothing'})`,
        ),
  );
  for (const [parent, range] of Object.entries(profile.parents)) {
    const version = manifest.profiles[parent];
    record(
      state,
      version !== undefined && satisfiesRange(version, range)
        ? pass(
            `declaration.parent.${parent}`,
            `${profile.id} extends`,
            `declares ${parent} ${version}`,
          )
        : fail(
            `declaration.parent.${parent}`,
            `${profile.id} extends`,
            `does not declare parent ${parent}@${range}`,
          ),
    );
  }
  checkParts(state, {
    owner: profile.id,
    operations: profile.operations,
    reads: profile.reads,
    events: profile.events,
  });
  for (const extension of state.options.extensions ?? []) {
    const version = manifest.extensions[extension.id];
    const range = `^${extension.major}.0.0`;
    record(
      state,
      version !== undefined && satisfiesRange(version, range)
        ? pass(`declaration.extension.${extension.id}`, extension.id, `declares ${version}`)
        : fail(
            `declaration.extension.${extension.id}`,
            extension.id,
            `does not declare ${extension.id}@${range}`,
          ),
    );
    checkParts(state, {
      owner: extension.id,
      operations: extension.definition.operations ?? {},
      reads: extension.definition.reads ?? {},
      events: extension.definition.events ?? {},
    });
  }
  checkSenses(state);
}

function checkParts(
  state: RunState,
  parts: {
    owner: string;
    operations: Readonly<
      Record<
        string,
        {
          readonly required?: boolean;
        }
      >
    >;
    reads: Readonly<
      Record<
        string,
        {
          readonly required?: boolean;
        }
      >
    >;
    events: Readonly<
      Record<
        string,
        {
          readonly required?: boolean;
        }
      >
    >;
  },
): void {
  const manifest = state.connection.manifest;
  const groups: ReadonlyArray<
    [
      string,
      Readonly<
        Record<
          string,
          {
            readonly required?: boolean;
          }
        >
      >,
      Readonly<Record<string, unknown>>,
    ]
  > = [
    [
      'operation',
      parts.operations,
      manifest.operations,
    ],
    [
      'read',
      parts.reads,
      manifest.resources,
    ],
    [
      'event',
      parts.events,
      manifest.events,
    ],
  ];
  for (const [kind, defs, offered] of groups) {
    for (const [name, def] of Object.entries(defs)) {
      if (def.required === false && !Object.hasOwn(offered, name)) {
        continue;
      }
      record(
        state,
        Object.hasOwn(offered, name)
          ? pass(`declaration.${kind}.${name}`, `${parts.owner} ${name}`, `serves ${kind} ${name}`)
          : fail(
              `declaration.${kind}.${name}`,
              `${parts.owner} ${name}`,
              `does not serve required ${kind} ${name}`,
            ),
      );
    }
  }
}

function checkSenses(state: RunState): void {
  const manifest = state.connection.manifest;
  const used = new Set<string>();
  for (const part of [
    ...Object.values(manifest.operations),
    ...Object.values(manifest.resources),
    ...Object.values(manifest.events),
  ]) {
    if (part.sense !== undefined) {
      used.add(part.sense);
    }
  }
  const undescribed = [
    ...used,
  ].filter((sense) => !Object.hasOwn(manifest.senses, sense));
  record(
    state,
    undescribed.length === 0
      ? pass(
          'declaration.senses',
          `${state.options.profile.id} senses`,
          'every sense used is described',
        )
      : fail(
          'declaration.senses',
          `${state.options.profile.id} senses`,
          `senses without a descriptor: ${undescribed.join(', ')}`,
        ),
  );
}

//#endregion

//#region Behavior scenarios

async function checkIdentity(state: RunState): Promise<void> {
  const before = state.connection.identity;
  record(
    state,
    before.surface !== '' && before.instance !== ''
      ? pass('identity.subject', 'noetic://identity', `${before.surface} ${before.instance}`)
      : fail('identity.subject', 'noetic://identity', 'identity has an empty surface or instance'),
  );
  if (state.driver.replace === undefined) {
    record(
      state,
      absent('identity.replacement', 'noetic://identity', 'the driver cannot replace the subject'),
    );
    return;
  }
  const changed = waitForIdentityChange(state.connection, state.options.identityTimeoutMs ?? 5e3);
  const replaced = await state.driver.replace(state.ctx);
  if (!replaced) {
    record(
      state,
      absent(
        'identity.replacement',
        'noetic://identity',
        'the driver could not replace the subject',
      ),
    );
    return;
  }
  await changed;
  const after = state.connection.identity;
  record(
    state,
    after.instance !== before.instance
      ? pass('identity.replacement', 'noetic://identity', 'instance changed on replacement')
      : fail(
          'identity.replacement',
          'noetic://identity',
          'instance did not change when the subject was replaced (OVP-SUBJ-1)',
        ),
  );
}

function waitForIdentityChange(connection: Connection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const off = connection.onChange((change) => {
      if (change === 'identity') {
        done();
      }
    });
    function done(): void {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

async function checkRefusals(state: RunState): Promise<void> {
  const withRequired = presentOperations(state).find(
    ([, op]) => requiredFields(op.input).length > 0,
  );
  if (withRequired === undefined) {
    record(
      state,
      absent('errors.malformed', 'Errors malformed', 'no offered operation has required arguments'),
    );
  } else {
    const [op] = withRequired;
    const outcome = await callOp(state, {
      op,
      args: {},
    });
    record(
      state,
      outcome.status === 'error' && outcome.error.code === 'malformed'
        ? pass('errors.malformed', `${op} input`, 'missing arguments refused as malformed')
        : fail(
            'errors.malformed',
            `${op} input`,
            `missing arguments were not refused as malformed (${describeOutcome(outcome)})`,
          ),
    );
  }
  await checkUndeclared(state);
  await checkAmbiguous(state);
}

async function checkUndeclared(state: RunState): Promise<void> {
  if (!(state.connection instanceof McpConnection)) {
    record(state, absent('errors.undeclared', 'Errors undeclared', 'not an MCP connection'));
    return;
  }
  const call = await state.connection.callTool(
    'noetic.conformance.undeclared',
    {},
    {
      signal: state.ctx.signal,
      idempotencyKey: key('undeclared'),
    },
  );
  record(
    state,
    call.status === 'error' && call.error.code === 'undeclared'
      ? pass('errors.undeclared', 'Errors undeclared', 'an unknown tool is refused as undeclared')
      : fail(
          'errors.undeclared',
          'Errors undeclared',
          `an unknown tool was not refused as undeclared (${describeOutcome(call)})`,
        ),
  );
}

async function checkAmbiguous(state: RunState): Promise<void> {
  const call = await state.driver.ambiguous?.(state.ctx);
  if (call === undefined) {
    record(
      state,
      absent('errors.ambiguous', 'Errors ambiguous', 'the driver set up no ambiguous locator'),
    );
    return;
  }
  const outcome = await callOp(state, call);
  const candidates = outcome.status === 'error' ? outcome.error.details?.candidates : undefined;
  record(
    state,
    outcome.status === 'error' &&
      outcome.error.code === 'ambiguous' &&
      Array.isArray(candidates) &&
      candidates.length > 1
      ? pass(
          'errors.ambiguous',
          `${call.op} target`,
          'an ambiguous locator is refused with its candidates',
        )
      : fail(
          'errors.ambiguous',
          `${call.op} target`,
          `an ambiguous locator was not refused with candidates (OVP-REALITY-4; ${describeOutcome(outcome)})`,
        ),
  );
}

async function checkEffects(state: RunState): Promise<void> {
  for (const [op, def] of presentOperations(state)) {
    if (def.effects !== true) {
      continue;
    }
    const args = await state.driver.sample?.(op, state.ctx);
    if (args === undefined) {
      record(state, absent(`effects.${op}`, `${op} effects`, 'the driver could not set it up'));
      continue;
    }
    const idempotencyKey = key(op);
    const outcome = await callOp(state, {
      op,
      args,
      idempotencyKey,
    });
    const receipt = outcome.status === 'ok' ? receiptOf(outcome.output) : undefined;
    if (receipt === undefined) {
      record(
        state,
        fail(`effects.${op}`, `${op} output.receipt`, `no receipt (${describeOutcome(outcome)})`),
      );
      continue;
    }
    record(state, pass(`effects.${op}`, `${op} output.receipt`, `receipt ${receipt.actionId}`));
    await confirmEffect(state, op, receipt);
    if (def.once === true && outcome.status === 'ok') {
      await checkOnce(state, {
        op,
        args,
        idempotencyKey,
        output: outcome.output,
      });
    }
  }
}

async function confirmEffect(state: RunState, op: string, receipt: Receipt): Promise<void> {
  const confirmed = await state.driver.confirm?.(op, receipt, state.ctx);
  const status: ConformanceStatus =
    confirmed === undefined ? 'absent' : confirmed ? 'pass' : 'fail';
  const message =
    confirmed === undefined
      ? 'the driver could not confirm it through an independent sense'
      : confirmed
        ? 'confirmed through an independent sense'
        : 'the receipt describes an action that never happened';
  record(state, outcome(status)(`effects.${op}.confirmed`, `${op} effects`, message));
}

async function checkOnce(
  state: RunState,
  first: {
    op: string;
    args: Readonly<Record<string, unknown>>;
    idempotencyKey: string;
    output: unknown;
  },
): Promise<void> {
  const { op } = first;
  const again = await callOp(state, first);
  record(
    state,
    again.status === 'ok' && JSON.stringify(again.output) === JSON.stringify(first.output)
      ? pass(`once.${op}.replay`, `${op} once`, 'a repeated key returned the original outcome')
      : fail(
          `once.${op}.replay`,
          `${op} once`,
          `a repeated key did not return the original outcome (${describeOutcome(again)})`,
        ),
  );
  const alternate = await state.driver.alternate?.(op, state.ctx);
  if (alternate === undefined) {
    record(
      state,
      absent(`once.${op}.conflict`, `${op} once`, 'the driver gave no alternate arguments'),
    );
    return;
  }
  const conflict = await callOp(state, {
    op,
    args: alternate,
    idempotencyKey: first.idempotencyKey,
  });
  record(
    state,
    conflict.status === 'error' && conflict.error.code === 'conflict'
      ? pass(
          `once.${op}.conflict`,
          `${op} once`,
          'a reused key with new arguments is refused as conflict',
        )
      : fail(
          `once.${op}.conflict`,
          `${op} once`,
          `a reused key with new arguments was not refused (${describeOutcome(conflict)})`,
        ),
  );
}

async function checkDriverScenarios(state: RunState): Promise<void> {
  const verdict = await state.driver.healthyClaim?.(state.ctx);
  record(
    state,
    verdict === undefined
      ? absent('claim.healthy', 'OVP-CONF-2', 'the driver set up no healthy claim')
      : verdict === 'yes'
        ? pass('claim.healthy', 'OVP-CONF-2', 'a real claim about a healthy subject was proved yes')
        : fail(
            'claim.healthy',
            'OVP-CONF-2',
            `a real claim about a healthy subject was ${verdict}, not yes`,
          ),
  );
  if (presentOperations(state).some(([, op]) => hasSensitiveField(op))) {
    const masked = await state.driver.masked?.(state.ctx);
    record(
      state,
      masked === undefined
        ? absent('sensitive.masked', 'sensitive fields', 'the driver could not check the screen')
        : masked
          ? pass('sensitive.masked', 'sensitive fields', 'sensitive values are masked on screen')
          : fail('sensitive.masked', 'sensitive fields', 'a sensitive value is visible on screen'),
    );
  }
  const summaries = await state.driver.summaries?.(state.ctx);
  if (summaries === undefined) {
    record(state, absent('summaries', 'Senses formats', 'the driver collected no summaries'));
    return;
  }
  const wrong = summaries.filter((s) => !matchesSenseSummary(s.sense, s.summary));
  record(
    state,
    wrong.length === 0
      ? pass('summaries', 'Senses formats', `${summaries.length} summaries in format`)
      : fail(
          'summaries',
          'Senses formats',
          `out of format: ${wrong.map((s) => `${s.sense} '${s.summary}'`).join(', ')}`,
        ),
  );
}

function describeOutcome(outcome: CallResult): string {
  if (outcome.status === 'error') {
    return `${outcome.error.code}: ${outcome.error.message}`;
  }
  if (outcome.status === 'task') {
    return `task ${outcome.taskId}`;
  }
  return 'ok';
}

//#endregion

//#region Public API

/**
 * @public
 * Runs a profile's conformance scenarios against a server and reports each
 * result with the profile part it checks.
 */
export async function checkConformance(
  options: CheckConformanceOptions,
): Promise<ConformanceReport> {
  const signal = options.signal ?? new AbortController().signal;
  const artifacts = options.artifacts ?? createMemoryArtifactStore();
  const provider = isConnectionProvider(options.server)
    ? options.server
    : mcp(options.server, {
        profiles: [
          options.profile,
          ...parentsOf(options.profile),
        ],
        extensions: options.extensions ?? [],
      });
  let connections: ReadonlyArray<Connection>;
  try {
    connections = await provider.connect({
      name: 'conformance',
      signal,
      artifacts,
    });
  } catch (error) {
    return {
      profile: options.profile.id,
      passed: false,
      level: 'none',
      results: [
        fail('connect', options.profile.id, error instanceof Error ? error.message : String(error)),
      ],
    };
  }
  const [connection, ...rest] = connections;
  if (connection === undefined) {
    return {
      profile: options.profile.id,
      passed: false,
      level: 'none',
      results: [
        fail('connect', options.profile.id, 'the provider returned no connection'),
      ],
    };
  }
  const state: RunState = {
    options,
    connection,
    ctx: {
      connection,
      signal,
      artifacts,
    },
    results: [],
    driver: options.driver ?? {},
  };
  try {
    checkDeclaration(state);
    await checkIdentity(state);
    await checkRefusals(state);
    await checkEffects(state);
    await checkDriverScenarios(state);
  } finally {
    await Promise.all(
      [
        connection,
        ...rest,
      ].map((c) => c.release().catch(() => {})),
    );
  }
  return {
    profile: options.profile.id,
    identity: connection.identity,
    passed: state.results.every((r) => r.status === 'pass'),
    level: conformanceLevel(Object.keys(connection.manifest.senses)),
    results: state.results,
  };
}

//#endregion
