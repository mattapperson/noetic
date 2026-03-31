#!/usr/bin/env bun

import type { Step } from '@noetic/core';

import type { SuiteDefinition } from '../runner/describe';
import type { SuiteResult } from '../types/eval';
import { OptimizeScope } from '../types/eval';
import type { RegressionResult } from '../types/regression';
import { discoverEvalFiles } from './file-discovery';
import { reportResults, reportSummary } from './reporter';
import { watchFiles } from './watch';

//#region Types

type OptimizeScopeValue = (typeof OptimizeScope)[keyof typeof OptimizeScope];

interface CliArgs {
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

type ArgHandler = (args: CliArgs, argv: string[], index: number) => number;

//#endregion

//#region Constants

const VALID_SCOPES: ReadonlyArray<string> = Object.values(OptimizeScope);
const MAX_METRIC_CALLS = 10;

//#endregion

//#region Scope Helpers

function isValidScope(value: string): value is OptimizeScopeValue {
  return VALID_SCOPES.includes(value);
}

//#endregion

//#region Arg Parsing

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
    if (next && isValidScope(next)) {
      args.scope = next;
      return 1;
    }
    return 0;
  },
  '--budget': (args, argv, i) => {
    const next = argv[i + 1];
    if (next) {
      args.budget = Number.parseFloat(next);
      return 1;
    }
    return 0;
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

function parseArgs(argv: string[]): CliArgs {
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
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
    }
    i++;
  }

  return args;
}

//#endregion

//#region Helper Functions

async function loadEvalFiles(files: string[]): Promise<void> {
  for (const file of files) {
    await import(file);
  }
}

function buildScoreMap(result: SuiteResult): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const c of result.cases) {
    for (const s of c.scores) {
      scores[`${c.name}.${s.scorerId}`] = s.score;
    }
  }
  return scores;
}

async function handleBaselineSaving(results: SuiteResult[]): Promise<void> {
  const { saveBaseline } = await import('../regression/baseline');
  for (const result of results) {
    await saveBaseline(result);
  }
  console.log('Baselines saved');
}

async function handleRegressionCheck(results: SuiteResult[]): Promise<boolean> {
  const { checkRegression } = await import('../regression/comparator');
  let hasRegression = false;
  for (const result of results) {
    const regressionResult: RegressionResult = await checkRegression(result);
    if (regressionResult.passed) {
      continue;
    }
    hasRegression = true;
    console.log(`REGRESSION in ${result.suiteName}:`);
    for (const r of regressionResult.regressions) {
      console.log(
        `  ${r.caseName}: ${r.baselineScore.toFixed(2)} -> ${r.currentScore.toFixed(2)} (d${r.delta.toFixed(2)})`,
      );
    }
  }
  return hasRegression;
}

async function handleOptimization(
  suites: ReadonlyArray<SuiteDefinition>,
  args: CliArgs,
  evalFiles: string[],
): Promise<void> {
  console.log('Starting optimization...');
  const { optimize } = await import('../optimization/optimizer');
  const { runAllSuites } = await import('../runner/suite-runner');
  const { discoverFieldsFromSource } = await import('../static-analysis/ast-field-discovery');
  const { discoverFields, enrichWithSourceLocations } = await import(
    '../optimization/field-discovery'
  );

  const astFields = evalFiles.flatMap((f) => discoverFieldsFromSource(f));

  for (const suite of suites) {
    const runtimeFields = discoverFields(suite.step, undefined, args.scope);
    await optimize({
      step: suite.step,
      preEnrichedFields:
        astFields.length > 0 ? enrichWithSourceLocations(runtimeFields, astFields) : runtimeFields,
      scope: args.scope,
      runEval: async (modifiedStep: Step) => {
        const modifiedSuite: SuiteDefinition = {
          ...suite,
          step: modifiedStep,
        };
        const [result] = await runAllSuites([
          modifiedSuite,
        ]);
        return buildScoreMap(result);
      },
      maxMetricCalls: MAX_METRIC_CALLS,
      budget: args.budget,
      dryRun: args.dryRun,
    });
  }
  console.log('Optimization complete');
}

//#endregion

//#region Run Evals

async function runEvals(args: CliArgs): Promise<void> {
  const files = discoverEvalFiles(args.files);
  if (files.length === 0) {
    console.log('No .eval.ts files found');
    return;
  }

  console.log(`Found ${files.length} eval file(s)`);

  const { clearSuites, getSuites } = await import('../runner/registry');
  clearSuites();

  await loadEvalFiles(files);

  const suites = getSuites();
  if (suites.length === 0) {
    console.log('No eval suites registered');
    return;
  }

  const { runAllSuites } = await import('../runner/suite-runner');
  const results = await runAllSuites(suites);

  reportResults(results, {
    verbose: args.verbose,
    json: args.json,
  });
  if (!args.json) {
    reportSummary(results);
  }

  if (args.saveBaseline) {
    await handleBaselineSaving(results);
  }

  if (args.check) {
    const hasRegression = await handleRegressionCheck(results);
    if (hasRegression) {
      process.exit(1);
    }
  }

  if (args.optimize) {
    await handleOptimization(suites, args, files);
  }
}

//#endregion

//#region Main

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  const testIdx = rawArgs.indexOf('test');
  const cliArgv = testIdx >= 0 ? rawArgs.slice(testIdx + 1) : rawArgs;

  const args = parseArgs(cliArgv);

  if (!args.watch) {
    await runEvals(args);
    return;
  }

  const files = discoverEvalFiles(args.files);
  console.log('Watching for changes...');
  const watcher = watchFiles(files, () => {
    console.log('\nRe-running evals...');
    runEvals(args).catch(console.error);
  });

  await runEvals(args);

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

//#endregion
