/**
 * `noetic mission *` top-level CLI verb dispatcher. Each verb opens SQLite directly,
 * prints to stdout, and returns. The caller `cli.ts` handles `process.exit(0)`.
 */

import { createInterface } from 'node:readline/promises';

import { ensureDaemon } from '../../../../daemon-runtime/runtime.js';
import type { MissionFeatureRecord, MissionRecord, MissionStatus } from '../db/schema.js';
import type { MissionHierarchy, MissionHierarchySlice } from './store.js';
import {
  activateSlice,
  createMission,
  deleteMission,
  getMission,
  getMissionWithHierarchy,
  listMissions,
  updateMission,
} from './store.js';

//#region Types

type StdoutLike = Pick<NodeJS.WriteStream, 'write'>;
type StderrLike = Pick<NodeJS.WriteStream, 'write'>;

export interface MissionVerbOptions {
  stdout?: StdoutLike;
  stderr?: StderrLike;
  promptLine?: (prompt: string) => Promise<string>;
  ensureDaemonFn?: (cwd: string) => void;
}

interface VerbContext {
  cwd: string;
  args: ReadonlyArray<string>;
  stdout: StdoutLike;
  stderr: StderrLike;
  promptLine: (prompt: string) => Promise<string>;
  ensureDaemonFn: (cwd: string) => void;
}

interface VerbResult {
  exitCode: number;
}

type VerbHandler = (ctx: VerbContext) => Promise<VerbResult>;

//#endregion

//#region Helpers

const USAGE = [
  'Usage: noetic mission <verb> [args]',
  '',
  'Verbs:',
  '  create [title]                 Create a new mission (interactive prompt for title/description)',
  '  list                           List all missions grouped by status',
  '  show <missionId>               Print the mission hierarchy as an indented tree',
  '  activate-slice <sliceId>       Activate a slice and ensure the daemon is running',
  '  delete <missionId>             Delete a mission and all its descendants',
  '  autopilot <on|off> <missionId> Toggle autopilot on a mission',
  '',
].join('\n');

function writeLine(stream: StdoutLike, line: string): void {
  stream.write(`${line}\n`);
}

function defaultPromptLine(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl.question(prompt).finally(() => {
    rl.close();
  });
}

function describeMission(record: MissionRecord): string {
  const desc = record.description !== null ? ` — ${record.description}` : '';
  const autopilot = record.autopilotEnabled ? ' [autopilot]' : '';
  return `${record.id}  ${record.title}${desc}${autopilot}`;
}

function describeSlice(slice: MissionHierarchySlice): string {
  return `slice ${slice.id}  [${slice.status}] ${slice.title}`;
}

function describeFeature(
  feature: MissionFeatureRecord & {
    acceptanceCriteriaParsed: string[];
  },
): string {
  const fix =
    feature.generatedFromFeatureId !== null ? ` (fix of ${feature.generatedFromFeatureId})` : '';
  const blocked =
    feature.blockedReason !== null && feature.blockedReason.length > 0
      ? ` (blocked: ${feature.blockedReason})`
      : '';
  return `feature ${feature.id}  [${feature.loopState}] ${feature.title}${fix}${blocked}`;
}

function printMissionHierarchy(stream: StdoutLike, hierarchy: MissionHierarchy): void {
  writeLine(stream, describeMission(hierarchy.mission));
  for (const milestone of hierarchy.milestones) {
    writeLine(stream, `  milestone ${milestone.id}  [${milestone.status}] ${milestone.title}`);
    for (const slice of milestone.slices) {
      writeLine(stream, `    ${describeSlice(slice)}`);
      for (const feature of slice.features) {
        writeLine(stream, `      ${describeFeature(feature)}`);
      }
    }
    if (milestone.assertions.length > 0) {
      writeLine(stream, '    assertions:');
      for (const assertion of milestone.assertions) {
        writeLine(stream, `      [${assertion.status}] ${assertion.title}: ${assertion.assertion}`);
      }
    }
  }
}

function groupByStatus(records: ReadonlyArray<MissionRecord>): Map<MissionStatus, MissionRecord[]> {
  const grouped = new Map<MissionStatus, MissionRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.status) ?? [];
    list.push(record);
    grouped.set(record.status, list);
  }
  return grouped;
}

//#endregion

//#region Verb handlers

async function handleCreate(ctx: VerbContext): Promise<VerbResult> {
  const initialTitle = ctx.args.join(' ').trim();
  let title = initialTitle;
  if (title.length === 0) {
    title = (await ctx.promptLine('Mission title: ')).trim();
  }
  if (title.length === 0) {
    ctx.stderr.write('Error: mission title is required.\n');
    return {
      exitCode: 1,
    };
  }
  const description = (await ctx.promptLine('Mission description (optional): ')).trim();
  const created = createMission(ctx.cwd, {
    title,
    description: description.length > 0 ? description : undefined,
  });
  writeLine(ctx.stdout, `Created mission ${created.id}.`);
  writeLine(ctx.stdout, `Run \`noetic mission show ${created.id}\` to inspect it.`);
  return {
    exitCode: 0,
  };
}

async function handleList(ctx: VerbContext): Promise<VerbResult> {
  const missions = listMissions(ctx.cwd);
  if (missions.length === 0) {
    writeLine(ctx.stdout, 'No missions yet. Use `noetic mission create` to make one.');
    return {
      exitCode: 0,
    };
  }
  const grouped = groupByStatus(missions);
  const order: MissionStatus[] = [
    'planning',
    'active',
    'blocked',
    'complete',
    'archived',
  ];
  for (const status of order) {
    const list = grouped.get(status);
    if (list === undefined || list.length === 0) {
      continue;
    }
    writeLine(ctx.stdout, `# ${status} (${list.length})`);
    for (const mission of list) {
      writeLine(ctx.stdout, `  ${describeMission(mission)}`);
    }
  }
  return {
    exitCode: 0,
  };
}

async function handleShow(ctx: VerbContext): Promise<VerbResult> {
  const missionId = ctx.args[0];
  if (missionId === undefined || missionId.length === 0) {
    ctx.stderr.write('Usage: noetic mission show <missionId>\n');
    return {
      exitCode: 1,
    };
  }
  const hierarchy = getMissionWithHierarchy(ctx.cwd, missionId);
  if (hierarchy === null) {
    ctx.stderr.write(`Error: mission ${missionId} not found.\n`);
    return {
      exitCode: 1,
    };
  }
  printMissionHierarchy(ctx.stdout, hierarchy);
  return {
    exitCode: 0,
  };
}

async function handleActivateSlice(ctx: VerbContext): Promise<VerbResult> {
  const sliceId = ctx.args[0];
  if (sliceId === undefined || sliceId.length === 0) {
    ctx.stderr.write('Usage: noetic mission activate-slice <sliceId>\n');
    return {
      exitCode: 1,
    };
  }
  try {
    activateSlice(ctx.cwd, sliceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`Error: ${message}\n`);
    return {
      exitCode: 1,
    };
  }
  ctx.ensureDaemonFn(ctx.cwd);
  writeLine(ctx.stdout, `Activated slice ${sliceId}. Daemon ensured for autopilot.`);
  return {
    exitCode: 0,
  };
}

async function handleDelete(ctx: VerbContext): Promise<VerbResult> {
  const missionId = ctx.args[0];
  if (missionId === undefined || missionId.length === 0) {
    ctx.stderr.write('Usage: noetic mission delete <missionId>\n');
    return {
      exitCode: 1,
    };
  }
  const existing = getMission(ctx.cwd, missionId);
  if (existing === null) {
    ctx.stderr.write(`Error: mission ${missionId} not found.\n`);
    return {
      exitCode: 1,
    };
  }
  deleteMission(ctx.cwd, missionId);
  writeLine(ctx.stdout, `Deleted mission ${missionId}.`);
  return {
    exitCode: 0,
  };
}

async function handleAutopilot(ctx: VerbContext): Promise<VerbResult> {
  const toggle = ctx.args[0];
  const missionId = ctx.args[1];
  if ((toggle !== 'on' && toggle !== 'off') || missionId === undefined || missionId.length === 0) {
    ctx.stderr.write('Usage: noetic mission autopilot <on|off> <missionId>\n');
    return {
      exitCode: 1,
    };
  }
  const existing = getMission(ctx.cwd, missionId);
  if (existing === null) {
    ctx.stderr.write(`Error: mission ${missionId} not found.\n`);
    return {
      exitCode: 1,
    };
  }
  const enable = toggle === 'on';
  updateMission(ctx.cwd, missionId, {
    autopilotEnabled: enable,
    autopilotState: enable ? 'watching' : 'inactive',
  });
  if (enable) {
    ctx.ensureDaemonFn(ctx.cwd);
  }
  writeLine(ctx.stdout, `Autopilot ${enable ? 'enabled' : 'disabled'} for mission ${missionId}.`);
  return {
    exitCode: 0,
  };
}

//#endregion

//#region Dispatch registry

const VERB_HANDLERS: Record<string, VerbHandler> = {
  create: handleCreate,
  list: handleList,
  show: handleShow,
  'activate-slice': handleActivateSlice,
  delete: handleDelete,
  autopilot: handleAutopilot,
};

//#endregion

//#region Public API

export async function dispatchMissionVerb(
  argv: ReadonlyArray<string>,
  cwd: string,
  options: MissionVerbOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const promptLine = options.promptLine ?? defaultPromptLine;
  const ensureDaemonFn = options.ensureDaemonFn ?? ensureDaemon;
  const verb = argv[0];
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    stdout.write(USAGE);
    return;
  }
  const handler = VERB_HANDLERS[verb];
  if (handler === undefined) {
    stderr.write(`Unknown verb: ${verb}\n`);
    stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const ctx: VerbContext = {
    cwd,
    args: argv.slice(1),
    stdout,
    stderr,
    promptLine,
    ensureDaemonFn,
  };
  const result = await handler(ctx);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

//#endregion
