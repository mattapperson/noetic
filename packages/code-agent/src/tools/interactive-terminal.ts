/**
 * InteractiveTerminal tool — drive a TUI program through pilotty.
 *
 * Wraps the `pilotty` CLI (https://github.com/msmps/pilotty) so the agent
 * can spawn full-screen terminal applications, observe screen state, and
 * send keystrokes — things the regular Bash tool refuses to do.
 *
 * The factory accepts a `readonly` flag. In read-only mode the `spawn`
 * action rejects programs in `READONLY_BANNED_SPAWN_COMMANDS` (editors,
 * shells, agent CLIs, file managers, …) so an inspection-only tool
 * registration cannot launch a mutator. All other actions behave the
 * same in both modes.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ShellAdapter, Tool } from '@noetic-tools/core';
import { getToolCwd, tool } from '@noetic-tools/core';
import { z } from 'zod';
import type { MutationPolicy } from './mutation-policy.js';
import { isInteractiveTerminalMutation } from './mutation-policy.js';
import { shellQuote } from './path-utils.js';
import { READONLY_BANNED_SPAWN_COMMANDS, validateSpawnCommand } from './security.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from './truncate.js';

//#region Schemas

const SessionRefSchema = z
  .string()
  .min(1)
  .describe('Session name or UUID. Defaults to "default" if omitted.');

const SpawnSchema = z.object({
  action: z.literal('spawn'),
  command: z
    .string()
    .min(1)
    .describe('Program (and optional args) to run, e.g. "vim file.txt" or "htop".'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Human-readable session name. Strongly recommended so later actions can address it.'),
  cwd: z.string().min(1).optional().describe('Working directory for the spawned process.'),
});

const SnapshotSchema = z.object({
  action: z.literal('snapshot'),
  session: SessionRefSchema.optional(),
  format: z
    .enum([
      'text',
      'full',
      'compact',
    ])
    .optional()
    .describe('Output format. Default "text" — easiest to read; cursor shown as [_].'),
  settleMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Wait until the screen is stable for this many ms before sampling.'),
  awaitChange: z
    .string()
    .min(1)
    .optional()
    .describe('content_hash from a previous snapshot — block until the screen differs.'),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Total timeout in ms (pilotty default: 30000).'),
});

const KeySchema = z.object({
  action: z.literal('key'),
  key: z
    .string()
    .min(1)
    .describe(
      'Key, combo, or space-separated sequence (e.g. "Enter", "Ctrl+C", "Escape : w q Enter").',
    ),
  session: SessionRefSchema.optional(),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(1e4)
    .optional()
    .describe('Delay between keys in a sequence (ms, max 10000).'),
});

const TypeSchema = z.object({
  action: z.literal('type'),
  text: z.string().describe('Text to type at the current cursor. Supports \\n etc.'),
  session: SessionRefSchema.optional(),
});

const WaitForSchema = z.object({
  action: z.literal('wait-for'),
  pattern: z.string().min(1).describe('Text or regex pattern to wait for.'),
  regex: z.boolean().optional().describe('Treat pattern as a regex (default: literal match).'),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Total timeout in ms (pilotty default: 30000).'),
  session: SessionRefSchema.optional(),
});

const KillSchema = z.object({
  action: z.literal('kill'),
  session: SessionRefSchema.optional(),
});

const ListSessionsSchema = z.object({
  action: z.literal('list-sessions'),
});

const ClickSchema = z.object({
  action: z.literal('click'),
  row: z.number().int().min(0).describe('0-indexed row.'),
  col: z.number().int().min(0).describe('0-indexed column.'),
  session: SessionRefSchema.optional(),
});

const ScrollSchema = z.object({
  action: z.literal('scroll'),
  direction: z.enum([
    'up',
    'down',
  ]),
  amount: z.number().int().min(1).optional().describe('Lines to scroll (default: 1).'),
  session: SessionRefSchema.optional(),
});

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// Discriminated union — kept for per-action runtime validation and TS
// narrowing inside the tool. Not exposed as the LLM-visible schema because
// `z.toJSONSchema(z.discriminatedUnion(...))` emits a top-level `oneOf`,
// and OpenAI's function-calling validator rejects any tool whose root
// parameters schema is not `type: "object"`.
const InternalInputSchema = z.discriminatedUnion('action', [
  SpawnSchema,
  SnapshotSchema,
  KeySchema,
  TypeSchema,
  WaitForSchema,
  KillSchema,
  ListSessionsSchema,
  ClickSchema,
  ScrollSchema,
]);

type InternalInput = z.infer<typeof InternalInputSchema>;

// Flat LLM-visible schema. Every variant's fields appear as optional
// properties on a single object so `z.toJSONSchema` emits
// `{ type: "object", properties: {...} }` at the root. Per-action required
// fields are enforced by re-parsing through `InternalInputSchema` inside
// `execute`.
const InteractiveTerminalInputSchema = z.object({
  action: z
    .enum([
      'spawn',
      'snapshot',
      'key',
      'type',
      'wait-for',
      'kill',
      'list-sessions',
      'click',
      'scroll',
    ])
    .describe('Action to perform. Required fields vary by action — see field descriptions.'),
  command: z
    .string()
    .min(1)
    .optional()
    .describe('spawn (required): program (and optional args), e.g. "vim file.txt" or "htop".'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'spawn (optional, recommended): human-readable session name so later actions can address it.',
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe('spawn (optional): working directory for the spawned process.'),
  session: SessionRefSchema.optional().describe(
    'snapshot/key/type/wait-for/kill/click/scroll (optional): session name or UUID. Defaults to "default".',
  ),
  format: z
    .enum([
      'text',
      'full',
      'compact',
    ])
    .optional()
    .describe(
      'snapshot (optional): output format. Default "text" — easiest to read; cursor shown as [_].',
    ),
  settleMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'snapshot (optional): wait until the screen is stable for this many ms before sampling.',
    ),
  awaitChange: z
    .string()
    .min(1)
    .optional()
    .describe(
      'snapshot (optional): content_hash from a previous snapshot — block until the screen differs.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('snapshot/wait-for (optional): total timeout in ms (pilotty default: 30000).'),
  key: z
    .string()
    .min(1)
    .optional()
    .describe(
      'key (required): key, combo, or space-separated sequence (e.g. "Enter", "Ctrl+C", "Escape : w q Enter").',
    ),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(1e4)
    .optional()
    .describe('key (optional): delay between keys in a sequence (ms, max 10000).'),
  text: z
    .string()
    .optional()
    .describe('type (required): text to type at the current cursor. Supports \\n etc.'),
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe('wait-for (required): text or regex pattern to wait for.'),
  regex: z
    .boolean()
    .optional()
    .describe('wait-for (optional): treat pattern as a regex (default: literal match).'),
  row: z.number().int().min(0).optional().describe('click (required): 0-indexed row.'),
  col: z.number().int().min(0).optional().describe('click (required): 0-indexed column.'),
  direction: z
    .enum([
      'up',
      'down',
    ])
    .optional()
    .describe('scroll (required): scroll direction.'),
  amount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('scroll (optional): lines to scroll (default: 1).'),
});

const InteractiveTerminalOutputSchema = z.object({
  output: z.string().describe('Pilotty stdout (and stderr on failure), truncated for snapshots.'),
  exitCode: z
    .number()
    .optional()
    .describe('Process exit code. Undefined if the binary could not be located.'),
  action: z.string().describe('The action that was attempted.'),
  session: z
    .string()
    .optional()
    .describe('Session reference passed in (or the spawn name, when set).'),
  truncated: z.boolean().describe('Whether the output was truncated.'),
});

export type InteractiveTerminalInput = z.infer<typeof InteractiveTerminalInputSchema>;
export type InteractiveTerminalOutput = z.infer<typeof InteractiveTerminalOutputSchema>;

export { InteractiveTerminalInputSchema, InteractiveTerminalOutputSchema };

//#endregion

//#region Tool Description

const INTERACTIVE_TERMINAL_DESCRIPTION = `Drive an interactive TUI program through pilotty.

Use this when you need to interact with a full-screen terminal app (vim,
htop, lazygit, your own CLI's TUI, etc.) — the regular Bash tool refuses
to run such programs because they take over the terminal.

Workflow:
 1. spawn the program once (pass --name via the \`name\` field).
 2. snapshot the screen, then send key/type/click/scroll until the task is done.
 3. kill the session when finished.

Sessions are shared with the user's pilotty daemon; use \`list-sessions\`
to discover existing ones.

Snapshot formats:
 - "text" (default): rendered screen with the cursor shown as [_]. Easiest to read.
 - "full":           JSON with cursor coords, terminal size, content_hash, recognized elements.
 - "compact":        JSON metadata only, no text body.

Supported keys for the \`key\` action:
 - Named: Enter, Tab, Escape, Backspace, Space, Delete, Insert,
          Up, Down, Left, Right, Home, End, PageUp, PageDown, F1..F12
 - Combos: Ctrl+<key>, Alt+<key>
 - Sequences: space-separated, e.g. "Escape : w q Enter" or "Ctrl+X m".
   Use \`delayMs\` to insert a per-step pause if a TUI is timing-sensitive.

Read-only mode: when the tool is registered as part of the read-only
toolset, the \`spawn\` action rejects mutating programs (editors, shells,
file managers, agent CLIs, mutating git TUIs, …). It does NOT prevent
\`key\`/\`type\`/\`click\`/\`scroll\` from driving sessions started outside
this tool — be aware when attaching to an existing session.`;

//#endregion

//#region Binary resolution

const require = createRequire(import.meta.url);

const MISSING_BINARY_MESSAGE =
  'pilotty binary not found. Install it with `npm i -g pilotty` (or add `pilotty` as a project dependency) and try again.';

function resolvePilottyBin(): string | null {
  try {
    const pkgJsonPath = require.resolve('pilotty/package.json');
    return join(dirname(pkgJsonPath), 'bin', 'pilotty');
  } catch {
    return null;
  }
}

// Resolved once at module load — the binary path is stable for the process lifetime.
const PILOTTY_BIN: string | null = resolvePilottyBin();

//#endregion

//#region Argv builders

interface BuiltCommand {
  args: ReadonlyArray<string>;
  // For `spawn`, the user-supplied program string. We whitespace-split it
  // into argv tokens before passing each to pilotty; sh-quoting each token
  // separately preserves user intent (`vim file.txt` → argv `[vim, file.txt]`)
  // while preventing shell injection (`htop; rm -rf /` → argv tokens, not
  // re-parsed). Args with embedded spaces aren't supported — TUI programs
  // rarely need them and adding shell-quote-aware parsing is out of scope.
  trailingCommand?: string;
  session?: string;
}

function pushFlag(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) {
    return;
  }
  args.push(flag, String(value));
}

function pushBool(args: string[], flag: string, on: boolean | undefined): void {
  if (on) {
    args.push(flag);
  }
}

function pushSession(args: string[], session: string | undefined): void {
  pushFlag(args, '-s', session);
}

function buildSpawn(input: z.infer<typeof SpawnSchema>): BuiltCommand {
  const args: string[] = [
    'spawn',
  ];
  pushFlag(args, '--name', input.name);
  pushFlag(args, '--cwd', input.cwd);
  args.push('--');
  return {
    args,
    trailingCommand: input.command,
    session: input.name,
  };
}

function buildSnapshot(input: z.infer<typeof SnapshotSchema>): BuiltCommand {
  const args: string[] = [
    'snapshot',
    '--format',
    input.format ?? 'text',
  ];
  pushSession(args, input.session);
  pushFlag(args, '--settle', input.settleMs);
  pushFlag(args, '--await-change', input.awaitChange);
  pushFlag(args, '--timeout', input.timeoutMs);
  return {
    args,
    session: input.session,
  };
}

function buildKey(input: z.infer<typeof KeySchema>): BuiltCommand {
  const args: string[] = [
    'key',
  ];
  pushSession(args, input.session);
  pushFlag(args, '--delay', input.delayMs);
  args.push(input.key);
  return {
    args,
    session: input.session,
  };
}

function buildType(input: z.infer<typeof TypeSchema>): BuiltCommand {
  const args: string[] = [
    'type',
  ];
  pushSession(args, input.session);
  args.push(input.text);
  return {
    args,
    session: input.session,
  };
}

function buildWaitFor(input: z.infer<typeof WaitForSchema>): BuiltCommand {
  const args: string[] = [
    'wait-for',
  ];
  pushSession(args, input.session);
  pushBool(args, '--regex', input.regex);
  pushFlag(args, '--timeout', input.timeoutMs);
  args.push(input.pattern);
  return {
    args,
    session: input.session,
  };
}

function buildKill(input: z.infer<typeof KillSchema>): BuiltCommand {
  const args: string[] = [
    'kill',
  ];
  pushSession(args, input.session);
  return {
    args,
    session: input.session,
  };
}

function buildListSessions(): BuiltCommand {
  return {
    args: [
      'list-sessions',
    ],
  };
}

function buildClick(input: z.infer<typeof ClickSchema>): BuiltCommand {
  const args: string[] = [
    'click',
  ];
  pushSession(args, input.session);
  args.push(String(input.row), String(input.col));
  return {
    args,
    session: input.session,
  };
}

function buildScroll(input: z.infer<typeof ScrollSchema>): BuiltCommand {
  const args: string[] = [
    'scroll',
  ];
  pushSession(args, input.session);
  args.push(input.direction);
  if (input.amount !== undefined) {
    args.push(String(input.amount));
  }
  return {
    args,
    session: input.session,
  };
}

// Switch is used instead of a handler registry here because each case
// requires a narrowed discriminated-union type. A Record<string, Handler>
// would lose that narrowing and require unsafe casts.
function dispatchHandler(input: InternalInput): BuiltCommand {
  switch (input.action) {
    case 'spawn':
      return buildSpawn(input);
    case 'snapshot':
      return buildSnapshot(input);
    case 'key':
      return buildKey(input);
    case 'type':
      return buildType(input);
    case 'wait-for':
      return buildWaitFor(input);
    case 'kill':
      return buildKill(input);
    case 'list-sessions':
      return buildListSessions();
    case 'click':
      return buildClick(input);
    case 'scroll':
      return buildScroll(input);
  }
}

//#endregion

//#region Shell line assembly

function buildShellLine(binary: string, built: BuiltCommand): string {
  const parts: string[] = [
    shellQuote(binary),
  ];
  for (const arg of built.args) {
    parts.push(shellQuote(arg));
  }
  if (built.trailingCommand !== undefined) {
    for (const token of built.trailingCommand.trim().split(/\s+/)) {
      if (token === '') {
        continue;
      }
      parts.push(shellQuote(token));
    }
  }
  return parts.join(' ');
}

//#endregion

//#region Output assembly

type InteractiveTerminalAction = InternalInput['action'];

interface BuildOutputParams {
  action: InteractiveTerminalAction;
  session: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  isSnapshot: boolean;
}

function buildOutput(params: BuildOutputParams): InteractiveTerminalOutput {
  const { action, session, stdout, stderr, exitCode, isSnapshot } = params;

  let body = stdout;
  let truncated = false;

  // Snapshots can be tens of KB (text) up to MBs (full JSON of large
  // scrollback). Truncate every format so the agent's context stays
  // bounded. Other actions emit small JSON status objects — leave alone.
  if (isSnapshot) {
    const truncation = truncateTail(stdout);
    body = truncation.content;
    truncated = truncation.truncated;
    if (truncated) {
      body += `\n\n[Output truncated to last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} (${formatSize(DEFAULT_MAX_BYTES)} limit). Re-snapshot with format: "compact" for metadata only.]`;
    }
  }

  if (exitCode !== null && exitCode !== 0) {
    const segments = [
      body,
      stderr.trim(),
      `Command exited with code ${exitCode}`,
    ].filter((s) => s !== '');
    body = segments.join('\n\n');
  }

  return {
    output: body || '(no output)',
    exitCode: exitCode ?? undefined,
    action,
    session,
    truncated,
  };
}

//#endregion

//#region Execution helpers

function rejectSpawn(
  params: Extract<
    InternalInput,
    {
      action: 'spawn';
    }
  >,
  reason: string,
): InteractiveTerminalOutput {
  return {
    output: `Error: ${reason}`,
    action: params.action,
    session: params.name,
    truncated: false,
  };
}

function missingBinaryResult(params: InternalInput): InteractiveTerminalOutput {
  return {
    output: `Error: ${MISSING_BINARY_MESSAGE}`,
    action: params.action,
    session: 'session' in params ? params.session : undefined,
    truncated: false,
  };
}

interface RunPilottyArgs {
  params: InternalInput;
  binary: string;
  shell: ShellAdapter;
  cwd: string;
}

async function runPilotty(args: RunPilottyArgs): Promise<InteractiveTerminalOutput> {
  const { params, binary, shell, cwd } = args;
  const built = dispatchHandler(params);
  const line = buildShellLine(binary, built);
  const result = await shell.exec(line, {
    cwd,
  });
  return buildOutput({
    action: params.action,
    session: built.session,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    isSnapshot: params.action === 'snapshot',
  });
}

//#endregion

//#region Public API

export interface CreateInteractiveTerminalOptions {
  /**
   * When true, `spawn` rejects programs in
   * `READONLY_BANNED_SPAWN_COMMANDS`. Other actions are unaffected.
   */
  readonly?: boolean;
  mutationPolicy?: MutationPolicy;
}

export type InteractiveTerminalTool = Tool<
  typeof InteractiveTerminalInputSchema,
  typeof InteractiveTerminalOutputSchema
>;

export function createInteractiveTerminalTool(
  cwd: string,
  shell: ShellAdapter,
  options: CreateInteractiveTerminalOptions = {},
): InteractiveTerminalTool {
  const isReadonly = options.readonly === true;

  return tool({
    name: 'InteractiveTerminal',
    description: INTERACTIVE_TERMINAL_DESCRIPTION,
    input: InteractiveTerminalInputSchema,
    output: InteractiveTerminalOutputSchema,
    async execute(rawParams, toolCtx): Promise<InteractiveTerminalOutput> {
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const parsed = InternalInputSchema.safeParse(rawParams);
      if (!parsed.success) {
        return {
          output: `Error: invalid params for action "${rawParams.action}": ${formatZodIssues(parsed.error)}`,
          action: rawParams.action,
          session: rawParams.session,
          truncated: false,
        };
      }
      const params = parsed.data;
      if (params.action === 'spawn') {
        const validation = validateSpawnCommand(params.command, {
          readonly: isReadonly,
        });
        if (!validation.valid) {
          return rejectSpawn(params, validation.error);
        }
      }
      if (
        options.mutationPolicy &&
        isInteractiveTerminalMutation({
          action: params.action,
          command: 'command' in params ? params.command : undefined,
          readonlyBannedCommands: READONLY_BANNED_SPAWN_COMMANDS,
        })
      ) {
        const decision = await options.mutationPolicy.check({
          kind: 'interactive-terminal',
          cwd: liveCwd,
          command: 'command' in params ? params.command : undefined,
          action: params.action,
        });
        if (!decision.allowed) {
          return {
            output: `Error: ${decision.message}`,
            action: params.action,
            session: 'session' in params ? params.session : undefined,
            truncated: false,
          };
        }
      }
      if (PILOTTY_BIN === null) {
        return missingBinaryResult(params);
      }
      return runPilotty({
        params,
        binary: PILOTTY_BIN,
        shell,
        cwd: liveCwd,
      });
    },
  });
}

//#endregion
