/**
 * The source of a flow that runs JSON workflow documents (spec 23 § Versions): the
 * document, or the name it is looked up by, and the named workflows a subflow
 * `ref` can run. `hydrateWorkflow` and `workflow()` give it to `flowFrom`.
 */

import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { WorkflowDocument } from '../schemas/workflow';
import { WorkflowDocumentSchema } from '../schemas/workflow';

//#region Types

/**
 * @internal
 * A JSON workflow flow as it is hashed into a version and stored with a session.
 * Every field is present, `null` when unset, so the hash does not turn on which
 * were left out.
 */
export interface WorkflowSource {
  readonly document: WorkflowDocument | null;
  readonly ref: string | null;
  readonly workflows: Readonly<Record<string, WorkflowDocument>> | null;
}

const WorkflowSourceSchema = z.object({
  document: WorkflowDocumentSchema.nullable(),
  ref: z.string().nullable(),
  workflows: z.record(z.string(), WorkflowDocumentSchema).nullable(),
});

//#endregion

//#region Public API

/** @internal The source of a flow that runs `document`, or looks one up by `ref`, among `workflows`. */
export function workflowSource(from: {
  document?: WorkflowDocument;
  ref?: string;
  workflows?: ReadonlyMap<string, WorkflowDocument>;
}): WorkflowSource {
  return {
    document: from.document ?? null,
    ref: from.ref ?? null,
    workflows: from.workflows ? Object.fromEntries(from.workflows) : null,
  };
}

/**
 * @internal
 * A source read back from storage, checked against the schema this release
 * hydrates. The stored value is returned as it was written, so the flow built
 * from it is the flow that was stored.
 *
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` when it does not validate.
 */
export function storedWorkflowSource(stored: unknown): WorkflowSource {
  const parsed = WorkflowSourceSchema.safeParse(stored);
  if (!parsed.success) {
    throw new NoeticConfigError({
      code: 'WORKFLOW_VALIDATION_FAILED',
      message: `A stored workflow no longer validates: ${parsed.error.message}`,
      hint: 'The document was stored by an earlier release and this one cannot hydrate it. Settle the turn with a noetic:decision if it stops as stuck.',
    });
  }
  return frameworkCast<WorkflowSource>(stored);
}

/**
 * @internal
 * The named workflows a flow rebuilt from `source` resolves a `ref` against: the
 * stored ones, then any `current` holds that the source does not name (a
 * workflow registered after the flow was built is outside its source).
 */
export function namedWorkflows(
  source: WorkflowSource,
  current: ReadonlyMap<string, WorkflowDocument> | undefined,
): ReadonlyMap<string, WorkflowDocument> | undefined {
  if (!source.workflows) {
    return current;
  }
  return new Map([
    ...(current ?? []),
    ...Object.entries(source.workflows),
  ]);
}

//#endregion
