/**
 * Recognizes an agent's permission request for one of the bridged Noetic tools.
 *
 * A bridged tool is gated by the same steering and `needsApproval` checks as
 * in `callModel`, when the call reaches the bridge. The agent's own
 * permission request is a second gate `callModel` never has, so it is
 * answered `allow` without consulting the step's ACP permission policy.
 *
 * Because that skips the policy, a match must be exact: the title is one an
 * agent gives a call to one of the listed tools (see `bridgedToolTitles`).
 * Codex sends no title on the request, so its earlier `tool_call` with the
 * same id stands in. Fields the model chooses, like `rawInput`, never count.
 */

import type {
  AcpPermissionOption,
  AcpRequestPermissionRequest,
  AcpToolHost,
} from '@noetic-tools/types';
import { bridgedToolTitles } from '@noetic-tools/types';

//#region Types

type ToolCallUpdate = AcpRequestPermissionRequest['toolCall'];

//#endregion

//#region Helpers

/** opencode's `<server>_<tool>` title could also be a shell command's; a command is never ours. */
function isShellCommand(call: ToolCallUpdate, title: string, serverName: string): boolean {
  return call.kind === 'execute' && title.startsWith(`${serverName}_`);
}

function titledAsBridged(
  call: ToolCallUpdate | undefined,
  host: AcpToolHost,
  titles: ReadonlySet<string>,
): boolean {
  const title = call?.title;
  if (!call || !title || !titles.has(title)) {
    return false;
  }
  return !isShellCommand(call, title, host.serverName);
}

//#endregion

//#region Public API

/**
 * True when the request is for one of the host's tools. `announced` is the
 * agent's earlier `tool_call` update for the same id.
 */
export function isBridgedToolCall(
  request: AcpRequestPermissionRequest,
  host: AcpToolHost,
  announced: ToolCallUpdate | undefined,
): boolean {
  const titles = new Set(
    host.tools.flatMap((tool) => bridgedToolTitles(host.serverName, tool.name)),
  );
  return (
    titledAsBridged(request.toolCall, host, titles) || titledAsBridged(announced, host, titles)
  );
}

/** The option that allows the call once, falling back to any allow option. */
export function allowOnceOption(
  options: ReadonlyArray<AcpPermissionOption>,
): AcpPermissionOption | undefined {
  return (
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always')
  );
}

//#endregion
