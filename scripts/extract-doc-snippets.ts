/**
 * CI script: extracts TypeScript code blocks from MDX files for type-checking.
 *
 * Scans all .mdx files under packages/web/content/, extracts fenced ```ts/```typescript
 * blocks, and writes them as .ts files under packages/web/.typecheck-snippets/.
 *
 * Usage: bun scripts/extract-doc-snippets.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

//#region Constants

const CONTENT_DIR = 'packages/web/content';
const OUTPUT_DIR = 'packages/web/.typecheck-snippets';

const PREAMBLE = `// Auto-generated — do not edit. Run scripts/extract-doc-snippets.ts to regenerate.
/* eslint-disable */
// @ts-nocheck is NOT used — we want real type errors.

import type {
  AgentConfig, AgentHarness, AgentHooks,
  BudgetConfig, CallModelFn, Channel, Condition,
  Context, ConvergeConfig, DetachedHandle,
  EmbedFn, ExecutionContext, Item, ItemLog,
  LLMResponse, LoopConfig, MemoryHooks, MemoryLayer, MemoryScope,
  ModelParams, NoeticError, PlanConstraints, PlanNode,
  ProjectionPolicy, RecallLayerOutput, Runtime,
  ScopedStorage, SettleResult, Snapshot, Span,
  Step, StepLLM, StepLoop, StepRun,
  StorageAdapter, SteeringConfig, SteeringRule,
  Tool, ToolExecutionContext, TraceExporter,
  Until, Verdict, VerifyFn,
} from '@noetic/core';
import {
  adaptivePlan, aiCondition, all, any, branch, channel,
  compilePlan, cosineSimilarity, durableTaskState,
  embeddingMatch, execute, fork, AgentHarness,
  isNoeticConfigError, isNoeticError, loop,
  NoeticConfigError, NoeticErrorImpl, observationalMemory,
  otherwise, PlanNodeSchema, ralphWiggum, react,
  semanticRoute, semanticSwitch, Slot, spawn,
  staticContent, steering, step, tool,
  toolMemoryLayer, until, when, workingMemory,
} from '@noetic/core';
`;

//#endregion

//#region MDX Parsing

const TS_FENCE_RE = /^```(?:ts|typescript)\s*$/;
const FENCE_END_RE = /^```\s*$/;

function extractTypeScriptBlocks(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (!inBlock && TS_FENCE_RE.test(line.trim())) {
      inBlock = true;
      currentBlock = [];
      continue;
    }
    if (inBlock && FENCE_END_RE.test(line.trim())) {
      inBlock = false;
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
      }
      continue;
    }
    if (inBlock) {
      currentBlock.push(line);
    }
  }

  return blocks;
}

//#endregion

//#region File Discovery

function findMdxFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.mdx')) {
      results.push(fullPath);
    }
  }
  return results;
}

//#endregion

//#region Main

// Clean output directory
if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, {
    recursive: true,
  });
}
fs.mkdirSync(OUTPUT_DIR, {
  recursive: true,
});

const mdxFiles = findMdxFiles(CONTENT_DIR);
let snippetCount = 0;

for (const mdxFile of mdxFiles) {
  const content = fs.readFileSync(mdxFile, 'utf-8');
  const blocks = extractTypeScriptBlocks(content);

  if (blocks.length === 0) {
    continue;
  }

  const relativePath = path.relative(CONTENT_DIR, mdxFile);
  const baseName = relativePath.replace(/[/\\]/g, '__').replace('.mdx', '');

  for (let i = 0; i < blocks.length; i++) {
    const fileName = `${baseName}__${i}.ts`;
    const outputPath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(outputPath, `${PREAMBLE}\n${blocks[i]}\n`);
    snippetCount++;
  }
}

console.log(`Extracted ${snippetCount} TypeScript snippets from ${mdxFiles.length} MDX files.`);

//#endregion
