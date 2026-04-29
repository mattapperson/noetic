/**
 * `/mission ...` slash command — top-level dispatcher.
 *
 * The slash command receives the rest of the argv string as `args` (e.g.
 * `"new"`, `"show abc-123"`, `"autopilot on def"`). We split on the first
 * whitespace to get the verb and pass the remainder to the verb handler.
 *
 * Verbs:
 *   new                        Ink interview wizard → persist tree → optional autopilot
 *   show <missionId>           Ink hierarchy view (subscribes to missionEvents)
 *   list                       Text output, grouped by status
 *   activate-slice <sliceId>   Activate a slice + ensure daemon
 *   autopilot <on|off> <id>    Toggle autopilot on a mission
 *   delete <missionId>         Delete a mission and its descendants
 */

import type { ReactNode } from 'react';

import type {
  Command,
  CommandContext,
  LocalJsxCommandCall,
  LocalJsxCommandOnDone,
  LocalJsxCommandResult,
} from '../../../../types.js';
import { runMissionActivateSlice } from './activate-slice.js';
import { runMissionAutopilot } from './autopilot.js';
import { runMissionDelete } from './delete.js';
import { runMissionList } from './list.js';

//#region Verb dispatch types

interface ParsedInvocation {
  verb: string;
  rest: string;
}

interface VerbHandlerArgs {
  cwd: string;
  ctx: CommandContext;
  rest: string;
  onDone: LocalJsxCommandOnDone;
}

type VerbHandler = (args: VerbHandlerArgs) => Promise<ReactNode>;

//#endregion

//#region Helpers

const USAGE_LINES: ReadonlyArray<string> = [
  'Usage: /mission <verb> [args]',
  '  /mission new',
  '  /mission show <missionId>',
  '  /mission list',
  '  /mission activate-slice <sliceId>',
  '  /mission autopilot <on|off> <missionId>',
  '  /mission delete <missionId>',
];

function parseInvocation(args: string): ParsedInvocation {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {
      verb: '',
      rest: '',
    };
  }
  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex < 0) {
    return {
      verb: trimmed,
      rest: '',
    };
  }
  return {
    verb: trimmed.slice(0, spaceIndex),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}

function finishWithText(onDone: LocalJsxCommandOnDone, text: string): null {
  const result: LocalJsxCommandResult = text;
  onDone(result);
  return null;
}

//#endregion

//#region Verb handlers

const handleHelp: VerbHandler = async ({ onDone }) =>
  finishWithText(onDone, USAGE_LINES.join('\n'));

const handleList: VerbHandler = async ({ cwd, onDone }) => {
  const text = await runMissionList(cwd);
  return finishWithText(onDone, text);
};

const handleActivateSlice: VerbHandler = async ({ cwd, rest, onDone }) => {
  const text = await runMissionActivateSlice(cwd, rest);
  return finishWithText(onDone, text);
};

const handleAutopilot: VerbHandler = async ({ cwd, rest, onDone }) => {
  const text = await runMissionAutopilot(cwd, rest);
  return finishWithText(onDone, text);
};

const handleDelete: VerbHandler = async ({ cwd, rest, onDone }) => {
  const text = await runMissionDelete(cwd, rest);
  return finishWithText(onDone, text);
};

const handleNew: VerbHandler = async ({ cwd, onDone }) => {
  const { renderMissionNew } = await import('./new.js');
  return renderMissionNew({
    cwd,
    onDone,
  });
};

const handleShow: VerbHandler = async ({ cwd, rest, onDone }) => {
  if (rest.length === 0) {
    return finishWithText(onDone, 'Usage: /mission show <missionId>');
  }
  const { renderMissionShow } = await import('./show-render.js');
  return renderMissionShow({
    cwd,
    missionId: rest,
    onDone,
  });
};

//#endregion

//#region Verb registry

const VERB_HANDLERS: Record<string, VerbHandler> = {
  '': handleHelp,
  help: handleHelp,
  list: handleList,
  'activate-slice': handleActivateSlice,
  autopilot: handleAutopilot,
  delete: handleDelete,
  new: handleNew,
  show: handleShow,
};

//#endregion

//#region Command definition

const call: LocalJsxCommandCall = async (
  onDone: LocalJsxCommandOnDone,
  ctx: CommandContext,
  args: string,
): Promise<ReactNode> => {
  const { verb, rest } = parseInvocation(args);
  const handler = VERB_HANDLERS[verb];
  if (handler === undefined) {
    const message = `Unknown /mission verb: "${verb}".\n${USAGE_LINES.join('\n')}`;
    return finishWithText(onDone, message);
  }
  return handler({
    cwd: ctx.cwd,
    ctx,
    rest,
    onDone,
  });
};

export const mission: Command = {
  type: 'local-jsx',
  name: 'mission',
  description: 'Manage missions: new, show, list, activate-slice, autopilot, delete',
  load: async () => ({
    call,
  }),
};

//#endregion
