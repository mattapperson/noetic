/**
 * The source of a flow that runs JSON workflow documents (spec 23 § Versions): the
 * document, or the name it is looked up by, and the named workflows a subflow
 * `ref` can run. `hydrateWorkflow` and `workflow()` give it to `flowFrom`, so a
 * harness can store it with a turn and build the flow again from it.
 */

import type { ContextData } from '@noetic-tools/context';
import type { CustomItemMap, Step } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { WorkflowDocument } from '../schemas/workflow';
import { WorkflowDocumentSchema } from '../schemas/workflow';
import { flowFrom } from './flow-source';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateDocument } from './workflow-hydrator';

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

/**
 * Hydrates a complete `WorkflowDocument` into a live `Step` tree.
 *
 * @public
 * @param doc - Validated workflow document (version 1).
 * @param ctx - Hydration context with tool registry and step executor.
 * @param customItems - TypeScript declarations of the document's root custom items (spec 34).
 * @returns The root `Step` of the hydrated workflow. A harness given it as `agentGraph` stores the
 *   document with each session and resumes a turn on the document it began under (spec 23 § Versions).
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_MISMATCH` when `customItems` and the document give one name different types.
 * @throws `NoeticConfigError` with code `CONNECTION_UNKNOWN` when a node uses a connection the document's `connections` do not declare, or `CONNECTION_INVALID` when a node's connection is neither named nor implied, or a source entry is used beyond its events.
 */
export function hydrateWorkflow(
  doc: WorkflowDocument,
  ctx: HydrationContext,
  customItems?: CustomItemMap,
): Step<ContextData, string, string> {
  const source = workflowSource({
    document: doc,
    workflows: ctx.workflows,
  });
  return flowFrom(source, (from) => {
    if (from === source) {
      return hydrateDocument(doc, ctx, customItems);
    }
    const stored = storedWorkflowSource(from);
    if (!stored.document) {
      throw new NoeticConfigError({
        code: 'WORKFLOW_VALIDATION_FAILED',
        message: 'A stored workflow holds no document.',
        hint: 'hydrateWorkflow builds from a document. The stored flow was built another way.',
      });
    }
    return hydrateDocument(
      stored.document,
      {
        ...ctx,
        workflows: namedWorkflows(stored, ctx.workflows),
      },
      customItems,
    );
  });
}

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
