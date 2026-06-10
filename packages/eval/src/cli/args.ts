import { OptimizeScope } from '../types/eval';

//#region Types

type OptimizeScopeValue = (typeof OptimizeScope)[keyof typeof OptimizeScope];

export interface CliArgs {
  files: string[];
  verbose: boolean;
  json: boolean;
  watch: boolean;
  optimize: boolean;
  scope: OptimizeScopeValue;
  budget?: number;
  dryRun: boolean;
  saveBaseline: boolean;
  check: boolean;
}

/**
 * A CLI invocation error (bad flag, bad flag value). `main()` maps it to
 * exit code 2, distinguishing usage mistakes from eval failures (exit 1).
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Returns how many EXTRA argv entries the handler consumed (0 for boolean flags). */
type ArgHandler = (args: CliArgs, argv: string[], index: number) => number;

//#endregion

//#region Handler Registry

const VALID_SCOPES: ReadonlyArray<string> = Object.values(OptimizeScope);

function isValidScope(value: string): value is OptimizeScopeValue {
  return VALID_SCOPES.includes(value);
}

const argHandlers: Record<string, ArgHandler> = {
  '--verbose': (args) => {
    args.verbose = true;
    return 0;
  },
  '--json': (args) => {
    args.json = true;
    return 0;
  },
  '--watch': (args) => {
    args.watch = true;
    return 0;
  },
  '-u': (args) => {
    args.optimize = true;
    return 0;
  },
  '--scope': (args, argv, i) => {
    const next = argv[i + 1];
    if (next === undefined) {
      throw new UsageError(`--scope requires a value (one of: ${VALID_SCOPES.join(', ')})`);
    }
    if (!isValidScope(next)) {
      throw new UsageError(
        `Invalid --scope value "${next}" (expected one of: ${VALID_SCOPES.join(', ')})`,
      );
    }
    args.scope = next;
    return 1;
  },
  '--budget': (args, argv, i) => {
    const next = argv[i + 1];
    if (next === undefined) {
      throw new UsageError('--budget requires a numeric value');
    }
    const parsed = Number.parseFloat(next);
    if (Number.isNaN(parsed)) {
      throw new UsageError(`Invalid --budget value "${next}" (expected a number)`);
    }
    args.budget = parsed;
    return 1;
  },
  '--dry-run': (args) => {
    args.dryRun = true;
    return 0;
  },
  '--save-baseline': (args) => {
    args.saveBaseline = true;
    return 0;
  },
  '--check': (args) => {
    args.check = true;
    return 0;
  },
};

//#endregion

//#region Public API

/**
 * Parse `noetic test` arguments. Unknown flags and invalid flag values throw
 * `UsageError` — nothing is silently dropped or misread as a file pattern.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    files: [],
    verbose: false,
    json: false,
    watch: false,
    optimize: false,
    scope: OptimizeScope.PromptsOnly,
    dryRun: false,
    saveBaseline: false,
    check: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const handler = argHandlers[arg];
    if (handler) {
      i += handler(args, argv, i);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown flag "${arg}"`);
    } else {
      args.files.push(arg);
    }
    i++;
  }

  return args;
}

//#endregion
