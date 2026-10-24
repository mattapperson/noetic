import type { WorkflowReplayKey } from '@noetic-tools/types';
import { hashString, NoeticConfigError } from '@noetic-tools/types';

/**
 * Build the `replayKey` function a JSON node's declarative `replayKey` describes
 * (spec 26 § Replay keys). The key is `<node id>:<hash of the selected input>`: the
 * node id keeps two different nodes that read the same input from fighting over one
 * ledger entry, while nodes that share an id — the same worker leaf written into
 * several paths — share entries by design.
 *
 * The interpreter turns a throwing `replayKey` into a warning and runs the step
 * without replay, so the step itself never fails.
 *
 * @throws `NoeticConfigError` with code `INVALID_REPLAY_KEY_INPUT` from the returned
 * function, when `from` meets an input that is not a JSON object.
 */
export function workflowReplayKey(
  nodeId: string,
  spec: WorkflowReplayKey,
): (input: string) => string {
  if (spec === true) {
    return (input) => `${nodeId}:${hashString(asText(input))}`;
  }
  return (input) => {
    const fields = inputObject(input, nodeId);
    return `${nodeId}:${hashString(JSON.stringify(spec.from.map((key) => fields[key] ?? null)))}`;
  };
}

/** JSON nodes pass strings, but a `decide` answer can arrive as an object. */
function asText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function inputObject(input: unknown, nodeId: string): Record<string, unknown> {
  const parsed = typeof input === 'string' ? parseJson(input) : input;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NoeticConfigError({
      code: 'INVALID_REPLAY_KEY_INPUT',
      message: `Node '${nodeId}' keys replay on input properties, but its input is not a JSON object.`,
      hint: 'Use `"replayKey": true` to key on the whole input, or feed the node a JSON object.',
    });
  }
  return Object.fromEntries(Object.entries(parsed));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
