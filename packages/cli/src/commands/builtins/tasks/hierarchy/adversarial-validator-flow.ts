/**
 * Step-graph validator that replaces the legacy `bun test`-only validator.
 *
 * The user's spec is "adversarial review of the code + agent-ci, with
 * failure feedback re-seeding a fresh implementer." This module owns
 * just the validator side: it runs **both** an agent-ci subprocess
 * **and** an LLM-driven adversarial code review in parallel via a
 * `fork({mode: 'all'})`, then merges them into a single
 * {@link ValidatorRunOutcome}.
 *
 * Behaviour:
 *
 * - **agent-ci passes ✅, adversarial review finds nothing ✅** → `pass`.
 * - **agent-ci fails ❌** → `fail`. The summary carries the agent-ci stderr
 *   so the failure feedback loop can surface concrete CI errors.
 * - **agent-ci passes ✅, adversarial finds issues ❌** → `fail`.
 *   `assertionOutcomes` lists each adversarial finding so the
 *   implementer's next attempt sees structured per-assertion failure
 *   data.
 * - **agent-ci spawn-error / missing binary** → `error` (or `pass` when
 *   `agentCiSkipOnMissing` is set, so projects without a CI workflow
 *   can still use the validator). The adversarial side is not
 *   short-circuited.
 *
 * Both paths produce a partial `ValidatorRunOutcome`; the fork's
 * `merge` reconciles them into the final outcome the validator-job
 * persists. The outer `step.run` only owns worktree resolution.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, ContextMemory, Step } from '@noetic/core';
import { fork, step } from '@noetic/core';
import { z } from 'zod';
import { DEFAULT_MODEL } from '../defaults.js';
import { tryLoadTask } from '../fs-store.js';
import type { Assertion, AssertionOutcome } from './schemas.js';
import { AssertionStatus } from './schemas.js';
import type { RunValidatorArgs, ValidatorRunOutcome } from './validator-job.js';

/**
 * Returns true if the working tree has at least one workflow file under
 * `.github/workflows/` that agent-ci could plausibly run. Without this,
 * `npx @redwoodjs/agent-ci run` exits 0 with a usage error on stderr,
 * which the spawn wrapper would otherwise mis-classify as a pass.
 */
export function hasAgentCiWorkflows(cwd: string): boolean {
  try {
    const entries = readdirSync(join(cwd, '.github', 'workflows'));
    return entries.some((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  } catch {
    return false;
  }
}

//#region Types

interface SpawnedChild {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type ValidatorShellSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

export interface AgentCiSubprocessOutcome {
  readonly status: 'pass' | 'fail' | 'error' | 'skipped';
  readonly summary: string;
  /**
   * True when agent-ci was not run — either the binary is missing or the
   * project has no workflow files in `.github/workflows/`. Skipped runs use
   * `status: 'skipped'`; this flag stays as a back-compat signal for older
   * consumers reading persisted run records.
   */
  readonly missing: boolean;
}

export interface AdversarialIssue {
  readonly assertionId: string | null;
  readonly title: string;
  readonly explanation: string;
  readonly severity: 'low' | 'medium' | 'high';
}

export interface AdversarialReviewOutput {
  readonly issues: ReadonlyArray<AdversarialIssue>;
}

const AdversarialReviewSchema = z.object({
  issues: z.array(
    z.object({
      assertionId: z.string().nullable(),
      title: z.string(),
      explanation: z.string(),
      severity: z.enum([
        'low',
        'medium',
        'high',
      ]),
    }),
  ),
});

export type RunAgentCiFn = (args: {
  readonly cwd: string;
  readonly maxOutputBytes: number;
}) => Promise<AgentCiSubprocessOutcome>;

export type ReadGitDiffFn = (args: {
  readonly cwd: string;
  readonly base: string;
}) => Promise<string>;

export type ResolvedAdversarialReviewFn = (args: {
  readonly diff: string;
  readonly assertions: ReadonlyArray<Assertion>;
  readonly featureTitle: string;
  readonly acceptanceCriteria: string;
  readonly ctx: Context<ContextMemory>;
}) => Promise<AdversarialReviewOutput>;

export interface AdversarialValidatorDeps {
  readonly runAgentCi?: RunAgentCiFn;
  readonly readGitDiff?: ReadGitDiffFn;
  readonly runAdversarialReview?: ResolvedAdversarialReviewFn;
  readonly agentCiCommand?: string;
  readonly agentCiArgs?: ReadonlyArray<string>;
  /** Treat agent-ci `missing` as `pass` rather than `error`. Default: `true`. */
  readonly agentCiSkipOnMissing?: boolean;
  /**
   * Pre-flight check: returns true iff the project has agent-ci workflows
   * worth running. When false, `createDefaultRunAgentCi` returns
   * `{status: 'pass', missing: true}` (skipped) without invoking the binary.
   * Defaults to {@link hasAgentCiWorkflows}.
   */
  readonly hasAgentCiWorkflowsFn?: (cwd: string) => boolean;
  readonly diffBase?: string;
  readonly maxOutputBytes?: number;
  readonly spawnFn?: ValidatorShellSpawn;
  /** Model used by the default adversarial-review LLM step. */
  readonly adversarialModel?: string;
}

//#endregion

//#region Constants

const DEFAULT_AGENT_CI_COMMAND = 'npx';
const DEFAULT_AGENT_CI_ARGS: ReadonlyArray<string> = [
  '@redwoodjs/agent-ci',
  'run',
  '--quiet',
];
const DEFAULT_DIFF_BASE = 'main';
const DEFAULT_MAX_OUTPUT_BYTES = 4_096;
const DEFAULT_ADVERSARIAL_MODEL = DEFAULT_MODEL;

const ADVERSARIAL_LLM_INSTRUCTIONS = [
  'You are an adversarial code reviewer for a code-agent system. The implementer',
  'just landed code in a worktree. Your job is to find any way the change still',
  "fails the feature's acceptance criteria or the milestone's assertions.",
  '',
  'Inputs you will receive:',
  '- A `git diff` of the worktree branch against the base branch',
  '- The feature title + acceptance criteria',
  '- A list of structured assertions (id + statement)',
  '',
  'For each assertion that the diff appears to violate, emit one issue with',
  '`assertionId` set. For broader concerns not tied to a specific assertion',
  '(missed edge cases, regressions, security issues), emit issues with',
  '`assertionId: null`. Use `severity: "high"` only for definite breakages.',
  'When the implementation looks correct, emit an empty `issues` array.',
].join('\n');

//#endregion

//#region Subprocess helpers

function clampOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  return `${buf.subarray(0, maxBytes).toString('utf-8')}\n…[truncated]`;
}

interface SpawnAndWaitArgs {
  readonly spawnFn: ValidatorShellSpawn;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly captureCap: number;
}

interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: Error | null;
}

async function spawnAndWait(input: SpawnAndWaitArgs): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let child: SpawnedChild;
    try {
      child = input.spawnFn(input.command, input.args, {
        cwd: input.cwd,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf-8') >= input.captureCap) {
        return;
      }
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf-8') >= input.captureCap) {
        return;
      }
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: Error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        spawnError: err,
      });
    });
    child.on('exit', (code: number | null) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
        spawnError: null,
      });
    });
  });
}

const defaultSpawn: ValidatorShellSpawn = (command, args, options) => {
  const cp: ChildProcess = spawn(command, args.slice(), options);
  return cp;
};

function isMissingBinary(err: Error): boolean {
  if ('code' in err && err.code === 'ENOENT') {
    return true;
  }
  return /ENOENT|not found|spawn .*ENOENT/i.test(err.message);
}

export function createDefaultRunAgentCi(deps: AdversarialValidatorDeps): RunAgentCiFn {
  const command = deps.agentCiCommand ?? DEFAULT_AGENT_CI_COMMAND;
  const args = deps.agentCiArgs ?? DEFAULT_AGENT_CI_ARGS;
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const hasWorkflows = deps.hasAgentCiWorkflowsFn ?? hasAgentCiWorkflows;
  return async ({ cwd, maxOutputBytes }) => {
    if (!hasWorkflows(cwd)) {
      return {
        status: 'skipped',
        summary: 'agent-ci skipped: no workflow files in .github/workflows/',
        missing: true,
      };
    }
    const result = await spawnAndWait({
      spawnFn,
      command,
      args,
      cwd,
      captureCap: maxOutputBytes * 4,
    });
    if (result.spawnError !== null) {
      if (isMissingBinary(result.spawnError)) {
        return {
          status: 'skipped',
          summary: `agent-ci skipped: binary not found (${result.spawnError.message})`,
          missing: true,
        };
      }
      return {
        status: 'error',
        summary: `agent-ci spawn failed: ${result.spawnError.message}`,
        missing: false,
      };
    }
    const summary = clampOutput(
      result.stdout.length > 0 ? result.stdout : result.stderr,
      maxOutputBytes,
    );
    if (result.exitCode === 0) {
      return {
        status: 'pass',
        summary: summary.length > 0 ? summary : `${command} exited 0`,
        missing: false,
      };
    }
    if (result.exitCode === null) {
      return {
        status: 'error',
        summary: `${command} was killed by a signal`,
        missing: false,
      };
    }
    return {
      status: 'fail',
      summary: summary.length > 0 ? summary : `${command} exited ${result.exitCode}`,
      missing: false,
    };
  };
}

export function createDefaultReadGitDiff(deps: AdversarialValidatorDeps): ReadGitDiffFn {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  return async ({ cwd, base }) => {
    const result = await spawnAndWait({
      spawnFn,
      command: 'git',
      args: [
        'diff',
        `${base}...HEAD`,
      ],
      cwd,
      captureCap: 1e6,
    });
    if (result.spawnError !== null) {
      throw result.spawnError;
    }
    if (result.exitCode !== 0) {
      throw new Error(`git diff exited ${result.exitCode}: ${result.stderr}`);
    }
    return result.stdout;
  };
}

//#endregion

//#region Path outputs and merge

/**
 * Each fork path emits a `ValidatorRunOutcome`. The agent-ci path leaves
 * `assertionOutcomes` empty; the adversarial path populates it. The
 * `result` field carries a discriminating tag (`source: 'agent-ci' |
 * 'adversarial'`) so `merge` can pair them deterministically regardless
 * of completion order.
 */

interface PathResultMeta {
  readonly source: 'agent-ci' | 'adversarial';
  readonly agentCi?: {
    readonly status: AgentCiSubprocessOutcome['status'];
    readonly missing: boolean;
  };
  readonly adversarial?: {
    readonly issueCount: number;
    readonly issues: ReadonlyArray<AdversarialIssue>;
  };
}

function pathResult(meta: PathResultMeta): Record<string, unknown> {
  return {
    ...meta,
  };
}

function isPathResultMeta(value: unknown): value is PathResultMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('source' in value)) {
    return false;
  }
  return value.source === 'agent-ci' || value.source === 'adversarial';
}

interface CombineOutcomesArgs {
  readonly agentCi: AgentCiSubprocessOutcome;
  readonly review: AdversarialReviewOutput;
  readonly assertions: ReadonlyArray<Assertion>;
}

export function combineOutcomes(args: CombineOutcomesArgs): ValidatorRunOutcome {
  const adversarialFailed = args.review.issues.length > 0;
  const summaryParts: string[] = [];
  if (args.agentCi.status === 'pass') {
    summaryParts.push(`agent-ci: pass (${args.agentCi.summary.split('\n')[0] ?? ''})`);
  } else if (args.agentCi.status === 'skipped') {
    summaryParts.push(`agent-ci: skipped (${args.agentCi.summary})`);
  } else if (args.agentCi.status === 'fail') {
    summaryParts.push('agent-ci: fail');
    summaryParts.push(args.agentCi.summary);
  } else {
    summaryParts.push(`agent-ci: error: ${args.agentCi.summary}`);
  }
  if (adversarialFailed) {
    summaryParts.push(`adversarial review: ${args.review.issues.length} issue(s)`);
    for (const issue of args.review.issues) {
      summaryParts.push(`  - [${issue.severity}] ${issue.title}: ${issue.explanation}`);
    }
  } else {
    summaryParts.push('adversarial review: no issues found');
  }
  // 'skipped' is treated as a non-blocking outcome for the overall validator —
  // the run still passes if the adversarial side finds no issues.
  const status: ValidatorRunOutcome['status'] =
    args.agentCi.status === 'error'
      ? 'error'
      : args.agentCi.status === 'fail' || adversarialFailed
        ? 'fail'
        : 'pass';

  const assertionOutcomes: AssertionOutcome[] =
    status === 'pass'
      ? args.assertions.map((a) => ({
          assertionId: a.id,
          status: AssertionStatus.Passed,
        }))
      : buildFailedAssertionOutcomes(args.review.issues, args.assertions);

  return {
    status,
    summary: summaryParts.join('\n'),
    result: {
      agentCi: {
        status: args.agentCi.status,
        missing: args.agentCi.missing,
      },
      adversarial: {
        issueCount: args.review.issues.length,
      },
    },
    assertionOutcomes,
  };
}

function buildFailedAssertionOutcomes(
  issues: ReadonlyArray<AdversarialIssue>,
  assertions: ReadonlyArray<Assertion>,
): AssertionOutcome[] {
  const issuesById = new Map<string, AdversarialIssue[]>();
  for (const issue of issues) {
    if (issue.assertionId === null) {
      continue;
    }
    const existing = issuesById.get(issue.assertionId);
    if (existing === undefined) {
      issuesById.set(issue.assertionId, [
        issue,
      ]);
    } else {
      existing.push(issue);
    }
  }
  return assertions.map((a) => {
    const matched = issuesById.get(a.id);
    if (matched === undefined) {
      return {
        assertionId: a.id,
        status: AssertionStatus.Pending,
      };
    }
    return {
      assertionId: a.id,
      status: AssertionStatus.Failed,
      message: matched
        .map((issue) => `[${issue.severity}] ${issue.title}: ${issue.explanation}`)
        .join('; '),
    };
  });
}

//#endregion

//#region Fork paths

interface ValidatorContextInput {
  readonly args: RunValidatorArgs;
  readonly worktreePath: string;
}

function buildAgentCiPathStep(
  deps: AdversarialValidatorDeps,
): Step<ContextMemory, ValidatorContextInput, ValidatorRunOutcome> {
  const runAgentCi = deps.runAgentCi ?? createDefaultRunAgentCi(deps);
  const skipOnMissing = deps.agentCiSkipOnMissing ?? true;
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return step.run({
    id: 'validator.agent-ci',
    execute: async (input) => {
      const outcome = await runAgentCi({
        cwd: input.worktreePath,
        maxOutputBytes,
      });
      const effective: AgentCiSubprocessOutcome =
        outcome.missing && !skipOnMissing
          ? {
              status: 'error',
              summary: outcome.summary,
              missing: true,
            }
          : outcome;
      // The agent-ci subprocess's `'skipped'` is non-blocking — the fork
      // outcome maps it to `'pass'` so `mode: 'all'` doesn't reject the path,
      // while the original status is preserved on `result.agentCi.status`.
      const pathStatus: ValidatorRunOutcome['status'] =
        effective.status === 'skipped' ? 'pass' : effective.status;
      return {
        status: pathStatus,
        summary: effective.summary,
        result: pathResult({
          source: 'agent-ci',
          agentCi: {
            status: effective.status,
            missing: effective.missing,
          },
        }),
        assertionOutcomes: [],
      };
    },
  });
}

function buildAdversarialPathStep(
  deps: AdversarialValidatorDeps,
): Step<ContextMemory, ValidatorContextInput, ValidatorRunOutcome> {
  const readGitDiff = deps.readGitDiff ?? createDefaultReadGitDiff(deps);
  const runAdversarialReview = deps.runAdversarialReview ?? createDefaultRunAdversarialReview(deps);
  const diffBase = deps.diffBase ?? DEFAULT_DIFF_BASE;
  return step.run({
    id: 'validator.adversarial-review',
    execute: async (input, ctx) => {
      const diff = await readGitDiff({
        cwd: input.worktreePath,
        base: diffBase,
      });
      const review = await runAdversarialReview({
        diff,
        assertions: input.args.assertions,
        featureTitle: input.args.feature.title,
        acceptanceCriteria: input.args.feature.acceptanceCriteria,
        ctx,
      });
      const issueCount = review.issues.length;
      return {
        status: issueCount > 0 ? 'fail' : 'pass',
        summary:
          issueCount > 0
            ? `adversarial review: ${issueCount} issue(s)`
            : 'adversarial review: no issues found',
        result: pathResult({
          source: 'adversarial',
          adversarial: {
            issueCount,
            issues: review.issues,
          },
        }),
        assertionOutcomes: [],
      };
    },
  });
}

function createDefaultRunAdversarialReview(
  deps: AdversarialValidatorDeps,
): ResolvedAdversarialReviewFn {
  const model = deps.adversarialModel ?? DEFAULT_ADVERSARIAL_MODEL;
  const llmStep: Step<ContextMemory, string, AdversarialReviewOutput> = step.llm({
    id: 'validator.adversarial-review.llm',
    model,
    instructions: ADVERSARIAL_LLM_INSTRUCTIONS,
    output: AdversarialReviewSchema,
  });
  return async (args) => {
    const userPrompt = buildAdversarialPrompt({
      diff: args.diff,
      assertions: args.assertions,
      featureTitle: args.featureTitle,
      acceptanceCriteria: args.acceptanceCriteria,
    });
    return args.ctx.harness.run(llmStep, userPrompt, args.ctx);
  };
}

export function buildAdversarialPrompt(args: {
  readonly diff: string;
  readonly assertions: ReadonlyArray<Assertion>;
  readonly featureTitle: string;
  readonly acceptanceCriteria: string;
}): string {
  const lines: string[] = [];
  lines.push('# Feature');
  lines.push(`Title: ${args.featureTitle}`);
  lines.push('', '## Acceptance criteria', args.acceptanceCriteria);
  lines.push('', '## Assertions');
  if (args.assertions.length === 0) {
    lines.push('(no structured assertions)');
  } else {
    for (const a of args.assertions) {
      lines.push(`- id="${a.id}" — ${a.title}: ${a.assertion}`);
    }
  }
  lines.push('', '## Diff (`git diff main...HEAD`)');
  lines.push('```diff');
  lines.push(args.diff.length > 0 ? args.diff : '(empty diff — no changes detected)');
  lines.push('```');
  return lines.join('\n');
}

//#endregion

//#region Fork merge

function extractAgentCiFromPath(outcome: ValidatorRunOutcome): AgentCiSubprocessOutcome | null {
  const meta = outcome.result;
  if (meta === undefined || !isPathResultMeta(meta) || meta.source !== 'agent-ci') {
    return null;
  }
  if (meta.agentCi === undefined) {
    return null;
  }
  return {
    status: meta.agentCi.status,
    summary: outcome.summary,
    missing: meta.agentCi.missing,
  };
}

function extractAdversarialFromPath(outcome: ValidatorRunOutcome): AdversarialReviewOutput | null {
  const meta = outcome.result;
  if (meta === undefined || !isPathResultMeta(meta) || meta.source !== 'adversarial') {
    return null;
  }
  if (meta.adversarial === undefined) {
    return null;
  }
  return {
    issues: meta.adversarial.issues,
  };
}

function mergeForkOutcomes(args: {
  readonly results: ReadonlyArray<ValidatorRunOutcome>;
  readonly assertions: ReadonlyArray<Assertion>;
}): ValidatorRunOutcome {
  let agentCi: AgentCiSubprocessOutcome | null = null;
  let review: AdversarialReviewOutput | null = null;
  for (const r of args.results) {
    const ac = extractAgentCiFromPath(r);
    if (ac !== null) {
      agentCi = ac;
      continue;
    }
    const adv = extractAdversarialFromPath(r);
    if (adv !== null) {
      review = adv;
    }
  }
  if (agentCi === null || review === null) {
    return {
      status: 'error',
      summary: 'validator fork lost a path output',
    };
  }
  return combineOutcomes({
    agentCi,
    review,
    assertions: args.assertions,
  });
}

//#endregion

//#region Public API

/**
 * Build the Step-graph validator. Returns a `step.run` that resolves
 * the leaf-task worktree, then dispatches a `fork({mode: 'all'})` over
 * the agent-ci and adversarial-review paths and merges their outcomes.
 */
export function buildAdversarialValidatorStep(
  deps: AdversarialValidatorDeps = {},
): Step<ContextMemory, RunValidatorArgs, ValidatorRunOutcome> {
  const agentCiPath = buildAgentCiPathStep(deps);
  const adversarialPath = buildAdversarialPathStep(deps);
  return step.run({
    id: 'validator.flow',
    execute: async (args, ctx) => {
      const leafTaskId = args.feature.taskId;
      if (leafTaskId === null) {
        return {
          status: 'error',
          summary: `feature ${args.feature.id} has no linked leaf task`,
        };
      }
      const leafTask = await tryLoadTask(args.ctx, leafTaskId);
      if (leafTask === null) {
        return {
          status: 'error',
          summary: `leaf task ${leafTaskId} not found`,
        };
      }
      if (leafTask.worktreePath === null || leafTask.worktreePath.length === 0) {
        return {
          status: 'error',
          summary: `leaf task ${leafTaskId} has no worktree provisioned`,
        };
      }
      const input: ValidatorContextInput = {
        args,
        worktreePath: leafTask.worktreePath,
      };
      const forkStep = fork<ContextMemory, ValidatorContextInput, ValidatorRunOutcome>({
        id: 'validator.fork',
        mode: 'all',
        paths: () => [
          agentCiPath,
          adversarialPath,
        ],
        merge: (results) =>
          mergeForkOutcomes({
            results,
            assertions: args.assertions,
          }),
      });
      try {
        return await ctx.harness.run(forkStep, input, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          summary: `validator flow failed: ${message}`,
        };
      }
    },
  });
}

//#endregion
