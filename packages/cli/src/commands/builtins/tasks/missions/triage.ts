import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentHarness, Context, FsAdapter, ShellAdapter } from '@noetic/core';
import { step } from '@noetic/core';
import { z } from 'zod';

import { createReadOnlyTools } from '../../../../tools/index.js';
import type { MissionFeatureRecord } from '../db/schema.js';
import type { ValidatorFailureSummary } from './prompts.js';
import { buildTriageUserPrompt, TRIAGE_SYSTEM_PROMPT } from './prompts.js';

//#region Types

const ReviewLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

/** @public Envelope produced by the triage LLM step. */
export const TriageEnvelopeSchema = z.object({
  promptMd: z.string().min(1),
  reviewLevel: ReviewLevelSchema,
});

/** @public Result of {@link TriageEnvelopeSchema} parsing. */
export type TriageEnvelope = z.infer<typeof TriageEnvelopeSchema>;

/** @public Argument bag for {@link triageFeature}. */
export interface TriageInput {
  feature: MissionFeatureRecord;
  cwd: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  model: string;
  parentSliceVerification?: string;
  validatorFailure?: ValidatorFailureSummary;
  harness: AgentHarness;
  parentCtx: Context;
}

/** @public Result returned by {@link triageFeature}. */
export interface TriageOutput {
  promptMdPath: string;
  reviewLevel: 0 | 1 | 2 | 3;
}

//#endregion

//#region Helpers

const AcceptanceCriteriaArraySchema = z.array(z.string());

function parseAcceptanceCriteria(raw: string): string[] {
  return AcceptanceCriteriaArraySchema.parse(JSON.parse(raw));
}

async function writePromptMd(promptMdPath: string, content: string): Promise<void> {
  await mkdir(dirname(promptMdPath), {
    recursive: true,
  });
  await writeFile(promptMdPath, content, 'utf8');
}

//#endregion

//#region Public API

/**
 * @public
 * Triage a mission feature into a fully-specified `<cwd>/.noetic/PROMPT.md`
 * via a one-shot LLM call wrapped by `step.llm`. When `validatorFailure` is
 * supplied, the triage prompt switches into Fix-task mode.
 */
export async function triageFeature(input: TriageInput): Promise<TriageOutput> {
  const acceptanceCriteria = parseAcceptanceCriteria(input.feature.acceptanceCriteria);
  const userPrompt = buildTriageUserPrompt({
    feature: {
      id: input.feature.id,
      title: input.feature.title,
      description: input.feature.description ?? '',
      acceptanceCriteria,
    },
    parentSliceVerification: input.parentSliceVerification,
    validatorFailure: input.validatorFailure,
  });

  const readOnlyTools = createReadOnlyTools({
    cwd: input.cwd,
    fs: input.fs,
    shell: input.shell,
  });

  const triageStep = step.llm({
    id: 'mission-triage',
    model: input.model,
    instructions: TRIAGE_SYSTEM_PROMPT,
    tools: readOnlyTools,
    output: TriageEnvelopeSchema,
  });

  const envelope = await input.harness.run(triageStep, userPrompt, input.parentCtx);
  const promptMdPath = join(input.cwd, '.noetic', 'PROMPT.md');
  await writePromptMd(promptMdPath, envelope.promptMd);
  return {
    promptMdPath,
    reviewLevel: envelope.reviewLevel,
  };
}

//#endregion
