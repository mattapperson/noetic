#!/usr/bin/env bun

import type { Step } from '@noetic-tools/core';

import type { SuiteDefinition } from '../runner/describe';
import type { SuiteResult } from '../types/eval';
import type { RegressionResult } from '../types/regression';
import type { CliArgs } from './args';
import { parseCliArgs, UsageError } from './args';
import type { RegressionCheckOutcome, RunOutcome } from './exit-policy';
import { computeExitCode, ExitCode } from './exit-policy';
import { discoverEvalFiles } from './file-discovery';
import { reportResults, reportSummary } from './reporter';
import { watchFiles } from './watch';
import { buildChildArgs, createWatchRunner } from './watch-runner';

const MAX_METRIC_CALLS = 10;

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

function countFailedCases(results: SuiteResult[]): number {
  return results.reduce((sum, s) => sum + s.cases.filter((c) => !c.passed).length, 0);
}

async function handleBaselineSaving(results: SuiteResult[]): Promise<void> {
  const { saveBaseline } = await import('../regression/baseline');
  for (const result of results) {
    await saveBaseline(result);
  }
  console.log('Baselines saved');
}

async function handleRegressionCheck(results: SuiteResult[]): Promise<RegressionCheckOutcome> {
  const { checkRegression } = await import('../regression/comparator');
  const outcome: RegressionCheckOutcome = {
    regressed: false,
    missingCount: 0,
  };
  for (const result of results) {
    const regressionResult: RegressionResult = await checkRegression(result);
    if (!regressionResult.baselineFound) {
      console.log(`No baseline for "${result.suiteName}" — skipping regression check`);
      continue;
    }
    if (regressionResult.passed) {
      continue;
    }
    console.log(`REGRESSION in ${result.suiteName}:`);
    for (const r of regressionResult.regressions) {
      outcome.regressed = true;
      console.log(
        `  ${r.caseName}: ${r.baselineScore.toFixed(2)} -> ${r.currentScore.toFixed(2)} (d${r.delta.toFixed(2)})`,
      );
    }
    for (const name of regressionResult.missingCases) {
      outcome.missingCount++;
      console.log(`  MISSING ${name}: present in baseline but absent from this run`);
    }
  }
  return outcome;
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

async function runEvals(args: CliArgs): Promise<RunOutcome> {
  const outcome: RunOutcome = {
    unresolvedPatterns: [],
    failedCases: 0,
  };

  const discovery = discoverEvalFiles(args.files);
  outcome.unresolvedPatterns = discovery.unresolved;
  for (const pattern of discovery.unresolved) {
    console.error(`No eval file found for pattern "${pattern}"`);
  }

  const files = discovery.files;
  if (files.length === 0) {
    console.log('No .eval.ts files found');
    return outcome;
  }

  console.log(`Found ${files.length} eval file(s)`);

  const { clearSuites, getSuites } = await import('../runner/registry');
  clearSuites();

  await loadEvalFiles(files);

  const suites = getSuites();
  if (suites.length === 0) {
    console.log('No eval suites registered');
    return outcome;
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

  outcome.failedCases = countFailedCases(results);

  if (args.saveBaseline) {
    await handleBaselineSaving(results);
  }

  if (args.check) {
    outcome.regressionCheck = await handleRegressionCheck(results);
  }

  if (args.optimize) {
    await handleOptimization(suites, args, files);
  }

  return outcome;
}

async function runWatchMode(args: CliArgs): Promise<void> {
  // Fresh subprocess per run: in-process re-import() is module-cached under
  // Bun, so eval file bodies would never re-execute on a re-run.
  const childArgs = buildChildArgs(process.argv.slice(2));
  const runner = createWatchRunner({
    runChild: async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          process.argv[1],
          ...childArgs,
        ],
        {
          stdio: [
            'inherit',
            'inherit',
            'inherit',
          ],
        },
      );
      return await child.exited;
    },
    onExit: (code) => {
      console.log(`\nEval run exited with code ${code}. Watching for changes...`);
    },
  });

  // Limitation: only the eval files themselves are watched, not their
  // transitive imports — restart the watcher after editing agent modules.
  const discovery = discoverEvalFiles(args.files);
  console.log('Watching for changes...');
  const watcher = watchFiles(discovery.files, () => {
    console.log('\nRe-running evals...');
    runner.trigger();
  });

  runner.trigger();

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  const testIdx = rawArgs.indexOf('test');
  const cliArgv = testIdx >= 0 ? rawArgs.slice(testIdx + 1) : rawArgs;

  let args: CliArgs;
  try {
    args = parseCliArgs(cliArgv);
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exitCode = ExitCode.Usage;
      return;
    }
    throw err;
  }

  if (!args.watch) {
    const outcome = await runEvals(args);
    process.exitCode = computeExitCode(outcome);
    return;
  }

  // Watch mode never exits on child failures; the watcher itself exits 0.
  await runWatchMode(args);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = ExitCode.Failure;
});
