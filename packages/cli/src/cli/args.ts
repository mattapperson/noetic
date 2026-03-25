/**
 * CLI argument parsing.
 */

import type { AgentConfig } from '../types/config.js';
import { AgentConfigSchema } from '../types/config.js';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';
const DEFAULT_MAX_TURNS = 5e1;

export function parseArgs(argv: string[]): AgentConfig {
  const args = argv.slice(2);
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  let apiKey = process.env.OPENROUTER_API_KEY ?? '';
  let maxTurns = DEFAULT_MAX_TURNS;

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

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!apiKey) {
    process.stderr.write('Error: OPENROUTER_API_KEY not set. Use --api-key or set the env var.\n');
    process.exit(1);
  }

  return AgentConfigSchema.parse({
    model,
    cwd,
    apiKey,
    maxTurns,
  });
}

function printHelp(): void {
  process.stdout.write(`
Usage: noetic [options]

Options:
  --model <model>      Model to use (default: ${DEFAULT_MODEL})
  --cwd <dir>          Working directory (default: current directory)
  --api-key <key>      OpenRouter API key (or set OPENROUTER_API_KEY)
  --max-turns <n>      Maximum conversation turns (default: ${DEFAULT_MAX_TURNS})
  -h, --help           Show this help message
`);
}
