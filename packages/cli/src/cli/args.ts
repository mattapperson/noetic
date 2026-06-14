/**
 * CLI argument parsing.
 */

import type { AgentConfig, CliFlags } from '../types/config.js';
import { AgentConfigSchema, DEFAULT_CLI_FLAGS } from '../types/config.js';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';
const DEFAULT_MAX_TURNS = 5e1;

// RFC 4122 UUID v1-v8 (zod's accepted format). Used to validate `--session-id`
// and the direct value form of `--resume <id>`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ParsedArgs {
  config: AgentConfig;
  flags: CliFlags;
}

interface ParseState {
  model: string;
  cwd: string;
  apiKey: string;
  maxTurns: number;
  flags: CliFlags;
}

function createInitialParseState(): ParseState {
  return {
    model: DEFAULT_MODEL,
    cwd: process.cwd(),
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    maxTurns: DEFAULT_MAX_TURNS,
    flags: {
      ...DEFAULT_CLI_FLAGS,
    },
  };
}

function requireNext(args: ReadonlyArray<string>, index: number): string | undefined {
  return index + 1 < args.length ? args[index + 1] : undefined;
}

function parseResumeArg(args: ReadonlyArray<string>, index: number, flags: CliFlags): number {
  const next = requireNext(args, index);
  if (next !== undefined && UUID_RE.test(next)) {
    flags.resume = next;
    return index + 1;
  }
  flags.resume = true;
  return index;
}

function parseSessionId(args: ReadonlyArray<string>, index: number, flags: CliFlags): number {
  const id = requireNext(args, index);
  if (id === undefined) {
    return index;
  }
  if (!UUID_RE.test(id)) {
    process.stderr.write(`Error: --session-id must be a valid UUID (got: ${id})\n`);
    process.exit(1);
  }
  flags.sessionId = id;
  return index + 1;
}

function parseValueOption(state: ParseState, arg: string, value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (arg === '--model') {
    state.model = value;
    state.flags.modelExplicit = true;
    return true;
  }
  if (arg === '--cwd') {
    state.cwd = value;
    return true;
  }
  if (arg === '--api-key') {
    state.apiKey = value;
    return true;
  }
  if (arg === '--max-turns') {
    state.maxTurns = Number.parseInt(value, 10);
    return true;
  }
  if (arg === '--name' || arg === '-n') {
    state.flags.name = value;
    return true;
  }
  return false;
}

function parseFlagOption(state: ParseState, arg: string): boolean {
  if (arg === '--continue' || arg === '-c') {
    state.flags.continueLatest = true;
    return true;
  }
  if (arg === '--fork-session') {
    state.flags.forkSession = true;
    return true;
  }
  if (arg === '--no-session-persistence') {
    state.flags.noSessionPersistence = true;
    return true;
  }
  if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
  return false;
}

function parseArgAt(args: ReadonlyArray<string>, index: number, state: ParseState): number {
  const arg = args[index];
  if (arg === '--resume' || arg === '-r') {
    return parseResumeArg(args, index, state.flags);
  }
  if (arg === '--session-id') {
    return parseSessionId(args, index, state.flags);
  }
  if (parseValueOption(state, arg, requireNext(args, index))) {
    return index + 1;
  }
  parseFlagOption(state, arg);
  return index;
}

function validateParsedState(state: ParseState): void {
  if (state.flags.forkSession && !state.flags.continueLatest && state.flags.resume === false) {
    process.stderr.write('Error: --fork-session requires --continue or --resume\n');
    process.exit(1);
  }
  if (!state.apiKey) {
    process.stderr.write(
      'Error: OpenRouter API key not found. Pass --api-key, set OPENROUTER_API_KEY, or add `machine openrouter.ai login api password <key>` to ~/.netrc.\n',
    );
    process.exit(1);
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const state = createInitialParseState();

  for (let i = 0; i < args.length; i++) {
    i = parseArgAt(args, i, state);
  }

  validateParsedState(state);

  const config = AgentConfigSchema.parse({
    model: state.model,
    cwd: state.cwd,
    apiKey: state.apiKey,
    maxTurns: state.maxTurns,
  });

  return {
    config,
    flags: state.flags,
  };
}

function printHelp(): void {
  process.stdout.write(`
Usage: noetic [options]

Options:
  --model <model>               Model to use (default: ${DEFAULT_MODEL})
  --cwd <dir>                   Working directory (default: current directory)
  --api-key <key>               OpenRouter API key (also reads OPENROUTER_API_KEY,
                                or 'machine openrouter.ai' from ~/.netrc)
  --max-turns <n>               Maximum conversation turns (default: ${DEFAULT_MAX_TURNS})

Session management:
  -c, --continue                Resume the most recent session for this cwd
  -r, --resume [id]             Open the picker, or resume a specific session by UUID
  --fork-session                On resume, fork into a new session id (requires -c or -r)
  --session-id <uuid>           Force a specific session id (used for a fresh
                                session's first write, or to override the
                                forked id when combined with --fork-session)
  -n, --name <name>             Set a custom title for this session
  --no-session-persistence      Don't write this session to disk

  -h, --help                    Show this help message
`);
}
