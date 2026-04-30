import type { AgentHarness, Context, FsAdapter, ShellAdapter } from '@noetic/core';
import { ralphWiggum } from '@noetic/core';
import { z } from 'zod';

import { createReadOnlyTools } from '../../../../tools/index.js';
import type {
  MissionContractAssertionRecord,
  MissionFeatureRecord,
  MissionValidatorRunRecord,
} from '../db/schema.js';
import { DEFAULT_IMPLEMENTATION_RETRY_BUDGET } from '../db/schema.js';
import { buildValidationSystemPrompt } from './prompts.js';
import { recordValidatorRun, updateValidatorRun } from './store.js';

//#region Constants

const DEFAULT_VALIDATOR_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_INNER_MAX_STEPS = 30;

//#endregion

//#region Types

const AssertionResultSchema = z.object({
  assertionId: z.string(),
  passed: z.boolean(),
  message: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

/** @public The validator's required JSON output shape. */
export const ValidatorRunSchema = z.object({
  status: z.enum([
    'pass',
    'fail',
    'blocked',
  ]),
  assertions: z.array(AssertionResultSchema),
  summary: z.string(),
  blockedReason: z.string().optional(),
});

/** @public Parsed validator output. */
export type ValidatorRunPayload = z.infer<typeof ValidatorRunSchema>;

/** @public Final result returned by {@link runValidator}. */
export interface ValidatorRunResult {
  status: 'pass' | 'fail' | 'blocked' | 'error';
  assertions: ReadonlyArray<{
    assertionId: string;
    passed: boolean;
    message: string;
    expected?: string;
    actual?: string;
  }>;
  summary: string;
  blockedReason?: string;
  runId: string;
}

/** @public Argument bag for {@link runValidator}. */
export interface RunValidatorInput {
  cwd: string;
  feature: MissionFeatureRecord;
  assertions: ReadonlyArray<MissionContractAssertionRecord>;
  taskContextBlob: string;
  /** Long-lived harness owned by the daemon (Phase 6) or supplied by the caller. */
  harness: AgentHarness;
  parentCtx: Context;
  /** Model identifier passed through to the inner ReAct agent. */
  model: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  /** Override the per-run timeout in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Override max iterations of the inner ralph loop. Default = retry budget. */
  maxIterations?: number;
  /** Override max steps inside each ralph iteration. Default 30. */
  innerMaxSteps?: number;
}

//#endregion

//#region Helpers

interface ParseOk {
  ok: true;
  data: ValidatorRunPayload;
}

interface ParseErr {
  ok: false;
  reason: string;
}

function parseValidatorJson(raw: string): ParseOk | ParseErr {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = ValidatorRunSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Schema mismatch: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }
  return {
    ok: true,
    data: parsed.data,
  };
}

function summarizeFailures(payload: ValidatorRunPayload): string {
  const failedAssertions = payload.assertions.filter((entry) => entry.passed === false);
  if (failedAssertions.length === 0 && payload.status === 'pass') {
    return 'Validator status was not "pass" or assertions list disagreed with status. Re-emit a JSON object whose `status` is "pass" only when every assertion has `passed: true`.';
  }
  const failureLines = failedAssertions.map((entry) => `- ${entry.assertionId}: ${entry.message}`);
  if (payload.status === 'blocked' && payload.blockedReason) {
    failureLines.unshift(`Blocked: ${payload.blockedReason}`);
  }
  return `Validator did not pass. Address the following before re-emitting JSON:\n${failureLines.join('\n')}`;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Validator timed out after ${ms}ms.`)), ms);
  });
}

interface VerifyOutcome {
  pass: boolean;
  feedback?: string;
  /** Last successful parse, retained so the outer caller can record it on success. */
  payload?: ValidatorRunPayload;
}

function makeVerifyTracker(): {
  verify: (output: unknown) => Promise<VerifyOutcome>;
  lastPayload: () => ValidatorRunPayload | null;
} {
  let lastPayload: ValidatorRunPayload | null = null;
  return {
    verify: async (output: unknown) => {
      const raw = typeof output === 'string' ? output : JSON.stringify(output);
      const parsed = parseValidatorJson(raw);
      if (!parsed.ok) {
        return {
          pass: false,
          feedback: `Invalid validator JSON output. ${parsed.reason}. Re-emit a JSON object matching the schema.`,
        };
      }
      lastPayload = parsed.data;
      const allAssertionsPassed = parsed.data.assertions.every((entry) => entry.passed);
      if (parsed.data.status === 'pass' && allAssertionsPassed) {
        return {
          pass: true,
          payload: parsed.data,
        };
      }
      return {
        pass: false,
        feedback: summarizeFailures(parsed.data),
        payload: parsed.data,
      };
    },
    lastPayload: () => lastPayload,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

const AcceptanceCriteriaArraySchema = z.array(z.string());

function parseAcceptanceCriteria(raw: string): string[] {
  const parsed = AcceptanceCriteriaArraySchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

//#endregion

//#region Public API

/**
 * @public
 * Runs the validator agent for a single feature using `ralphWiggum`. Records
 * the lifecycle (`pending → running → pass | fail | blocked | error`) in the
 * `mission_validator_runs` table via the missions store. Bound by an
 * `AbortController` timeout (default 10 minutes).
 */
export async function runValidator(input: RunValidatorInput): Promise<ValidatorRunResult> {
  const startedAt = nowIso();
  const run: MissionValidatorRunRecord = recordValidatorRun(input.cwd, {
    featureId: input.feature.id,
    status: 'running',
    startedAt,
  });
  const runId = run.id;

  try {
    const acceptance = parseAcceptanceCriteria(input.feature.acceptanceCriteria);

    const instructions = buildValidationSystemPrompt({
      feature: {
        title: input.feature.title,
        description: input.feature.description ?? '',
        acceptanceCriteria: acceptance,
      },
      assertions: input.assertions.map((assertion) => ({
        id: assertion.id,
        statement: assertion.assertion,
      })),
      taskContextBlob: input.taskContextBlob,
    });

    const readOnlyTools = createReadOnlyTools({
      cwd: input.cwd,
      fs: input.fs,
      shell: input.shell,
    });

    const tracker = makeVerifyTracker();

    const validatorStep = ralphWiggum({
      model: input.model,
      instructions,
      tools: readOnlyTools,
      verify: tracker.verify,
      maxIterations: input.maxIterations ?? DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
      innerMaxSteps: input.innerMaxSteps ?? DEFAULT_INNER_MAX_STEPS,
    });

    const handle = input.harness.detachedSpawn(
      validatorStep,
      input.taskContextBlob,
      input.parentCtx,
      {
        threadId: `validator-${runId}`,
      },
    );

    const timeoutMs = input.timeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
    await Promise.race([
      handle.await(),
      timeoutAfter(timeoutMs),
    ]);

    const payload = tracker.lastPayload();
    if (payload === null) {
      const errorResult: ValidatorRunResult = {
        status: 'error',
        assertions: [],
        summary: 'Validator never produced a parseable JSON envelope.',
        runId,
      };
      updateValidatorRun(input.cwd, runId, {
        status: 'error',
        completedAt: nowIso(),
        resultJson: JSON.stringify({
          summary: errorResult.summary,
        }),
      });
      return errorResult;
    }

    const allAssertionsPassed = payload.assertions.every((entry) => entry.passed);
    const finalStatus: ValidatorRunResult['status'] =
      payload.status === 'pass' && allAssertionsPassed
        ? 'pass'
        : payload.status === 'blocked'
          ? 'blocked'
          : 'fail';

    updateValidatorRun(input.cwd, runId, {
      status: finalStatus,
      completedAt: nowIso(),
      resultJson: JSON.stringify(payload),
    });

    return {
      status: finalStatus,
      assertions: payload.assertions,
      summary: payload.summary,
      blockedReason: payload.blockedReason,
      runId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateValidatorRun(input.cwd, runId, {
      status: 'error',
      completedAt: nowIso(),
      resultJson: JSON.stringify({
        error: message,
      }),
    });
    return {
      status: 'error',
      assertions: [],
      summary: message,
      runId,
    };
  }
}

//#endregion
