/**
 * What a document's `runCode` nodes may ask. A node's `subprocess` picks the
 * host its code runs on, so a document a host did not write may name a
 * harness subprocess adapter only when the host's `runCode` grant lists it
 * (spec 26 § runCode).
 */

import type { RunCodeGrant, WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import { NoeticConfigError, walkWorkflow } from '@noetic-tools/types';

//#region Types

type RunCodeNode = Extract<
  WorkflowNode,
  {
    kind: 'runCode';
  }
>;

//#endregion

//#region Public API

/**
 * Checks every `runCode` node's `subprocess` against the grant. Inline
 * subflows count; named refs resolve from the host's own registry and are not
 * checked.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a name the grant does not list.
 */
export function checkRunCode(doc: WorkflowDocument, grant: RunCodeGrant | undefined): void {
  for (const node of walkWorkflow(doc.root)) {
    if (node.kind === 'runCode') {
      checkRunCodeNode(node, grant ?? {});
    }
  }
}

/**
 * Checks one node's `subprocess` against the grant.
 *
 * The refusal names only what the grant lists, never the harness's other
 * adapters: its reader is the document's author.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a name the grant does not list.
 */
export function checkRunCodeNode(
  node: Pick<RunCodeNode, 'id' | 'subprocess'>,
  grant: RunCodeGrant,
): void {
  const granted = grant.subprocess ?? [];
  if (node.subprocess === undefined || granted.includes(node.subprocess)) {
    return;
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_NOT_ALLOWED',
    message: `Node '${node.id}' asks to run its code through the subprocess adapter ${JSON.stringify(node.subprocess)}, which the host does not allow.`,
    hint:
      granted.length > 0
        ? `Set \`subprocess\` to one of ${JSON.stringify(granted)}, or leave it out.`
        : 'Leave `subprocess` out.',
  });
}

/** The planner's view of where a `runCode` node may run. Empty when it may name no adapter. */
export function runCodePrompt(grant: RunCodeGrant | undefined): string {
  const granted = grant?.subprocess ?? [];
  return granted.length > 0
    ? `\nA runCode node may set "subprocess" to one of ${JSON.stringify(granted)} to run its code there; without it the code runs on the default.`
    : '';
}

//#endregion
