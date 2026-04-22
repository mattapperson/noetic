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

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  let apiKey = process.env.OPENROUTER_API_KEY ?? '';
  let maxTurns = DEFAULT_MAX_TURNS;
  const flags: CliFlags = {
    ...DEFAULT_CLI_FLAGS,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--model' && i + 1 < args.length) {
      model = args[++i];
      continue;
    }

    if (arg === '--cwd' && i + 1 < args.length) {
      cwd = args[++i];
      continue;
    }

    if (arg === '--api-key' && i + 1 < args.length) {
      apiKey = args[++i];
      continue;
    }

    if (arg === '--max-turns' && i + 1 < args.length) {
      maxTurns = Number.parseInt(args[++i], 10);
      continue;
    }

    if (arg === '--continue' || arg === '-c') {
      flags.continueLatest = true;
      continue;
    }

    if (arg === '--resume' || arg === '-r') {
      // --resume can be bare (picker) or followed by a UUID. Only consume the
      // next token if it looks like a UUID; otherwise leave it for the rest
      // of the parser.
      const next = args[i + 1];
      if (next !== undefined && UUID_RE.test(next)) {
        flags.resume = next;
        i++;
        continue;
      }
      flags.resume = true;
      continue;
    }

    if (arg === '--fork-session') {
      flags.forkSession = true;
      continue;
    }

    if (arg === '--session-id' && i + 1 < args.length) {
      const id = args[++i];
      if (!UUID_RE.test(id)) {
        process.stderr.write(`Error: --session-id must be a valid UUID (got: ${id})\n`);
        process.exit(1);
      }
      flags.sessionId = id;
      continue;
    }

    if ((arg === '--name' || arg === '-n') && i + 1 < args.length) {
      flags.name = args[++i];
      continue;
    }

    if (arg === '--no-session-persistence') {
      flags.noSessionPersistence = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (flags.forkSession && !flags.continueLatest && flags.resume === false) {
    process.stderr.write('Error: --fork-session requires --continue or --resume\n');
    process.exit(1);
  }

  if (!apiKey) {
    process.stderr.write('Error: OPENROUTER_API_KEY not set. Use --api-key or set the env var.\n');
    process.exit(1);
  }

  const config = AgentConfigSchema.parse({
    model,
    cwd,
    apiKey,
    maxTurns,
  });

  return {
    config,
    flags,
  };
}

function printHelp(): void {
  process.stdout.write(`
Usage: noetic [options]

Options:
  --model <model>               Model to use (default: ${DEFAULT_MODEL})
  --cwd <dir>                   Working directory (default: current directory)
  --api-key <key>               OpenRouter API key (or set OPENROUTER_API_KEY)
  --max-turns <n>               Maximum conversation turns (default: ${DEFAULT_MAX_TURNS})

Session management:
  -c, --continue                Resume the most recent session for this cwd
  -r, --resume [id]             Open the picker, or resume a specific session by UUID
  --fork-session                On resume, fork into a new session id (requires -c or -r)
  --session-id <uuid>           Force a specific session id
  -n, --name <name>             Set a custom title for this session
  --no-session-persistence      Don't write this session to disk

  -h, --help                    Show this help message
`);
}
