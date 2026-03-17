import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface DirectoryReviewConfig extends JudgeConfig {
  path: string;
  instructions: string;
  includeContents?: boolean;
  glob?: string;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  compliance: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Helper Functions

async function collectFiles(dirPath: string, globPattern?: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, globPattern);
      files.push(...nested);
      continue;
    }
    if (globPattern && !entry.name.match(globToRegex(globPattern))) {
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

//#endregion

//#region Public API

export function directoryReview(config: DirectoryReviewConfig): ScorerFn {
  return async (_execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const files = await collectFiles(config.path, config.glob);
    const fileList = files.map((f) => path.relative(config.path, f)).join('\n');

    let contentsSection = '';
    if (config.includeContents) {
      const contentParts: string[] = [];
      for (const filePath of files) {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(config.path, filePath);
        contentParts.push(`--- ${relativePath} ---\n${content}`);
      }
      contentsSection = `\n\nFile Contents:\n${contentParts.join('\n\n')}`;
    }

    const result = await runJudge({
      id: 'directory-review-judge',
      system: `You are a code/directory review judge. Review the directory structure and contents against the given instructions.
Score 0.0 = completely fails instructions, 1.0 = perfectly follows all instructions.
Respond with a compliance score and brief reasoning.`,
      input: `Objective: ${objective}\n\nInstructions: ${config.instructions}\n\nDirectory: ${config.path}\n\nFiles:\n${fileList}${contentsSection}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'directory-review',
      score: result.compliance,
      reason: result.reasoning,
      metadata: {
        path: config.path,
        fileCount: files.length,
      },
    };
  };
}

//#endregion
