/**
 * What core hands the verifier for one verify (spec 37 § Under the hood): the
 * subject and witnesses as gated `VerifyConnection`s, `act` run through the
 * usual gates, and the run document stored as a blob. Built against the
 * registry contract and `@noetic-tools/types/verify` only — core never imports
 * `@noetic-tools/verify` or `open-verification`.
 */

import type {
  ArtifactStore,
  BlobRef,
  ConnectionOperationInfo,
  Context,
  ExecuteStepFn,
  Step,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type {
  Anomaly,
  BlindSpot,
  VerificationRun,
  VerifyActResult,
  VerifyConnection,
  VerifyParticipant,
} from '@noetic-tools/types/verify';
import { AnomalyKind, OvpChannelIdSchema, VerifyConfigErrorCode } from '@noetic-tools/types/verify';
import { z } from 'zod';
import type { ResolvedConnection } from '../connections/registry-types';
import { createInMemoryArtifactStore } from '../runtime/in-memory-artifact-store';
import { idempotencyKeyFor, runRootOf, stepPathOf } from './connection-steps';

//#region Constants

/** The resource a server lists its blind spots at (spec 36 § Parts every server provides). */
const COVERAGE_RESOURCE = 'noetic://coverage';

/** The operation a server reports anomalies through. */
const DETECT_OP = 'noetic.detect';

const BlindSpotSchema = z.object({
  kind: z.enum([
    'channel-unobserved',
    'boundary-uncrossable',
    'buffer-truncated',
    'redacted',
    'still-in-flight',
    'effect-elsewhere',
  ]),
  channel: OvpChannelIdSchema.optional(),
  detail: z.string().min(1),
  impeaching: z.boolean(),
  remedy: z.string().optional(),
});

/** A named OVP anomaly kind or an `x-` kind; anything else is not OVP and is dropped. */
const AnomalyKindSchema = z.union([
  z.enum(AnomalyKind),
  z.string().regex(/^x-[a-z0-9-]+$/),
]);

const AnomalySchema = z.object({
  kind: AnomalyKindSchema,
  tier: z.enum([
    'observed',
    'absence-derived',
    'advisory',
  ]),
  claim: z.string(),
  counter: z.string(),
  between: z.tuple([
    OvpChannelIdSchema,
    OvpChannelIdSchema,
  ]),
  evidence: z.array(z.string()).default([]),
});

const ReportListSchema = z.union([
  z.array(z.unknown()),
  z.object({
    blindSpots: z.array(z.unknown()),
  }),
  z.object({
    anomalies: z.array(z.unknown()),
  }),
]);

/** A store per harness for runs whose harness configures none (spec 08: in memory by default). */
const FALLBACK_STORES = new WeakMap<object, ArtifactStore>();

//#endregion

//#region Types

/** The harness surface verification reads. */
interface HarnessWithVerification {
  /** `AgentHarness.verifier`, set from `new AgentHarness({ verification })`. */
  verifier?: unknown;
  /** `AgentHarness.artifacts`: `environment.artifacts`, else the harness's in-memory store. */
  artifacts?: ArtifactStore;
}

//#endregion

//#region Helpers

function harnessOf(ctx: Context): HarnessWithVerification {
  return frameworkCast<HarnessWithVerification>(ctx.harness);
}

function hasCoverage(resolved: ResolvedConnection): boolean {
  return Object.keys(resolved.manifest.resources).some((name) =>
    name.startsWith(COVERAGE_RESOURCE),
  );
}

/** The entries of a server's report: a bare list, or one under `blindSpots`/`anomalies`. */
function reportEntries(raw: unknown): unknown[] {
  const parsed = ReportListSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const data = parsed.data;
  if (Array.isArray(data)) {
    return data;
  }
  return 'blindSpots' in data ? data.blindSpots : data.anomalies;
}

/**
 * Each entry that is valid OVP, by `schema`; one that is not is dropped, so a
 * stored run stays an OVP VerificationRun any OVP tool can read.
 */
function validEntries<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  return reportEntries(raw).flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success
      ? [
          parsed.data,
        ]
      : [];
  });
}

function blindSpotsFrom(raw: unknown): BlindSpot[] {
  return validEntries(raw, BlindSpotSchema);
}

function anomaliesFrom(raw: unknown): Anomaly[] {
  return validEntries(raw, AnomalySchema);
}

/** A witness may run only operations without effects (spec 37 § Witnesses). */
function refuseWitnessEffects(
  name: string,
  op: string,
  info: ConnectionOperationInfo | undefined,
): void {
  if (info !== undefined && info.effects !== true) {
    return;
  }
  throw new NoeticConfigError({
    code: VerifyConfigErrorCode.Invalid,
    message: `Witness '${name}' was asked to run '${op}', which ${info ? 'has effects' : 'it does not offer'}.`,
    hint: 'A witness can look and cannot touch: run only its operations without effects, or make it the subject.',
  });
}

//#endregion

//#region Public API

/** The verifier the harness registered (`new AgentHarness({ verification })`), if any. */
export function verificationOf(ctx: Context): unknown {
  return harnessOf(ctx).verifier;
}

/** The harness artifact store (`environment.artifacts`), or an in-memory one per harness. */
export function artifactsOf(ctx: Context): ArtifactStore {
  const harness = harnessOf(ctx);
  const configured = harness.artifacts;
  if (configured) {
    return configured;
  }
  const key = frameworkCast<object>(ctx.harness);
  const existing = FALLBACK_STORES.get(key);
  if (existing) {
    return existing;
  }
  const store = createInMemoryArtifactStore();
  FALLBACK_STORES.set(key, store);
  return store;
}

/** A participant as `Verifier.prepare` sees it. */
export function participantOf(
  resolved: ResolvedConnection,
  role: 'subject' | 'witness',
): VerifyParticipant {
  return {
    name: resolved.name,
    role,
    identity: resolved.identity(),
    manifest: resolved.manifest,
    senses: resolved.manifest.senses,
    ...(resolved.manifest.determinism === undefined
      ? {}
      : {
          determinism: resolved.manifest.determinism,
        }),
  };
}

/**
 * A resolved connection as the verifier may use it: every call goes through the
 * registry's gates, and a witness refuses anything with effects.
 */
export function verifyConnectionOf(opts: {
  resolved: ResolvedConnection;
  role: 'subject' | 'witness';
  ctx: Context;
  stepId: string;
}): VerifyConnection {
  const { resolved, role, ctx, stepId } = opts;
  let calls = 0;
  const call = async (
    op: string,
    args: unknown,
    callOpts: {
      signal: AbortSignal;
    },
  ): Promise<unknown> => {
    if (role === 'witness') {
      refuseWitnessEffects(resolved.name, op, resolved.manifest.operations[op]);
    }
    calls += 1;
    return resolved.call(op, args, {
      signal: callOpts.signal,
      caller: 'step',
      idempotencyKey: `${idempotencyKeyFor(ctx, stepId)}:verify:${resolved.name}:${calls}`,
      stepId,
    });
  };
  return {
    name: resolved.name,
    manifest: resolved.manifest,
    identity: () => resolved.identity(),
    call,
    read: (resource, readOpts) => resolved.read(resource, readOpts),
    listen: (req) =>
      resolved.listen({
        ...req,
        cursor: null,
      }),
    ...(hasCoverage(resolved)
      ? {
          coverage: async (since, covOpts) =>
            blindSpotsFrom(
              await resolved.read(
                since === null
                  ? COVERAGE_RESOURCE
                  : `${COVERAGE_RESOURCE}?since=${encodeURIComponent(since)}`,
                covOpts,
              ),
            ),
        }
      : {}),
    ...(resolved.manifest.operations[DETECT_OP] === undefined
      ? {}
      : {
          detect: async (since, detectOpts) =>
            anomaliesFrom(
              await call(
                DETECT_OP,
                {
                  since,
                },
                detectOpts,
              ),
            ),
        }),
  };
}

/** Runs `act` in sequence, each step's output the next one's input. Never rejects: a throw becomes `error`. */
export async function runAct<TContext, I>(opts: {
  steps: ReadonlyArray<Step<TContext, I, unknown>>;
  input: I;
  ctx: Context<TContext>;
  executeStep: ExecuteStepFn;
  touched: ReadonlyArray<string>;
}): Promise<VerifyActResult> {
  const { steps, input, ctx, executeStep, touched } = opts;
  let current: unknown = input;
  try {
    for (const child of steps) {
      current = await executeStep(child, frameworkCast<I>(current), ctx);
    }
    return {
      output: current,
      pendingTasks: [],
      touched,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      pendingTasks: [],
      touched,
    };
  }
}

/** Stores a run document as a blob linked to the run, pinned, and notes it on the trace. */
export async function storeRun(opts: {
  ctx: Context;
  stepId: string;
  run: VerificationRun;
}): Promise<BlobRef> {
  const { ctx, stepId, run } = opts;
  const store = artifactsOf(ctx);
  const bytes = new TextEncoder().encode(JSON.stringify(run));
  const ref = await store.put(bytes, {
    mimeType: 'application/json',
    name: `${stepId}.verification-run.json`,
  });
  const stepPath = stepPathOf(ctx);
  await store.attach(ref.$blob.uri, {
    executionId: runRootOf(ctx).id,
    source: 'verify',
    pinned: true,
    ...(stepPath === undefined
      ? {}
      : {
          stepPath,
        }),
  });
  ctx.span.addEvent('verify.run', {
    stepId,
    uri: ref.$blob.uri,
  });
  return ref;
}

//#endregion
