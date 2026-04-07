import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaultBaselinePathSync } from '@noetic/core';
import { z } from 'zod';
import type { SuiteResult } from '../types/eval';
import type { Baseline } from '../types/regression';

//#region Constants

const VERSION = '1.0.0';

//#endregion

//#region Schemas

const ScoreResultSchema = z.object({
  scorerId: z.string(),
  score: z.number(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CaseResultSchema = z.object({
  name: z.string(),
  scores: z.array(ScoreResultSchema),
  passed: z.boolean(),
  duration: z.number(),
  error: z.string().optional(),
});

const SuiteResultSchema = z.object({
  suiteName: z.string(),
  objective: z.string(),
  cases: z.array(CaseResultSchema),
  aggregateScore: z.number(),
  duration: z.number(),
  timestamp: z.string(),
});

const BaselineSchema = z.object({
  suiteResult: SuiteResultSchema,
  createdAt: z.string(),
  version: z.string(),
});

//#endregion

//#region Helper Functions

function getBaselinePath(suiteName: string, explicitBasePath?: string): string {
  const sanitized = suiteName.replace(/[^a-zA-Z0-9-_]/g, '_');
  const basePath = getDefaultBaselinePathSync(explicitBasePath);
  return path.join(basePath, `${sanitized}.json`);
}

//#endregion

//#region Public API

export async function saveBaseline(
  suiteResult: SuiteResult,
  explicitBasePath?: string,
): Promise<string> {
  const filePath = getBaselinePath(suiteResult.suiteName, explicitBasePath);
  const dir = path.dirname(filePath);

  fs.mkdirSync(dir, {
    recursive: true,
  });

  const baseline: Baseline = {
    suiteResult,
    createdAt: new Date().toISOString(),
    version: VERSION,
  };

  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), 'utf-8');
  return filePath;
}

export async function loadBaseline(
  suiteName: string,
  explicitBasePath?: string,
): Promise<Baseline | null> {
  const filePath = getBaselinePath(suiteName, explicitBasePath);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return BaselineSchema.parse(JSON.parse(content));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

//#endregion
