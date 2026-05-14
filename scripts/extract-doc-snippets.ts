/**
 * CI script: extracts TypeScript code blocks from MDX files for type-checking.
 *
 * Scans all .mdx files under packages/web/content/, extracts fenced ```ts/```typescript
 * blocks (written as .ts) and ```tsx/```jsx blocks (written as .tsx) under
 * packages/web/.typecheck-snippets/. Fences tagged with the `noinclude` meta are skipped.
 *
 * Also extracts string literals from packages/web/components/landing/{hero,code-peek}.tsx
 * (any backtick-template assigned with `=`) so the homepage's rendered code samples are
 * validated against @noetic-tools/core just like docs fences are.
 *
 * Usage: bun scripts/extract-doc-snippets.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

//#region Types

interface ExtractedBlock {
  code: string;
  ext: 'ts' | 'tsx';
}

//#endregion

//#region Constants

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONTENT_DIR = path.join(ROOT_DIR, 'packages/web/content');
const OUTPUT_DIR = path.join(ROOT_DIR, 'packages/web/.typecheck-snippets');
const HOMEPAGE_FILES = [
  path.join(ROOT_DIR, 'packages/web/components/landing/hero.tsx'),
  path.join(ROOT_DIR, 'packages/web/components/landing/code-peek.tsx'),
];

const PREAMBLE = `// Auto-generated — do not edit. Run scripts/extract-doc-snippets.ts to regenerate.
/* eslint-disable */
// @ts-nocheck is NOT used — we want real type errors.

import type {
  AgentConfig, AgentHarnessContract, AgentHooks,
  BudgetConfig, CallModelRequest, Channel, Condition,
  Context, ContextMemory, ConvergeConfig, DetachedHandle,
  EmbedFn, ExecutionContext, InferMemory, Item, ItemLog,
  LLMResponse, LayerTimeouts, LoopConfig, MemoryConfig,
  MemoryHooks, MemoryLayer, MemoryScope,
  ModelParams, NoeticError, PlanConstraints, PlanNode,
  ProjectionPolicy, RecallLayerOutput, RetryPolicy,
  ScopedStorage, SettleResult, Snapshot, Span,
  Step, StepLLM, StepLoop, StepRun, StepSpawn,
  StorageAdapter, SteeringConfig, SteeringRule,
  Tool, ToolExecutionContext, ToolMemoryDeclaration, TraceExporter,
  Until, Verdict, VerifyFn,
} from '@noetic-tools/core';
import {
  adaptivePlan, aiCondition, all, any, branch, channel,
  compilePlan, cosineSimilarity, durableTaskState,
  embeddingMatch, execute, fork, AgentHarness,
  isNoeticConfigError, isNoeticError, loop,
  NoeticConfigError, NoeticErrorImpl, observationalMemory,
  otherwise, PlanNodeSchema, planMemory, ralphWiggum, react,
  semanticRoute, semanticSwitch, Slot, spawn,
  staticContent, steering, step, tool,
  toolMemoryLayer, until, when, workingMemory,
} from '@noetic-tools/core';

declare const searchTool: Tool;
declare const calcTool: Tool;
declare const agent: Step<ContextMemory, string, string>;
declare const observer: (buffer: ReadonlyArray<unknown>) => Promise<string[]>;
declare const semanticRecall: MemoryLayer;
`;

//#endregion

//#region MDX Parsing

const FENCE_OPEN_RE = /^```([a-z]+)(.*)$/;
const FENCE_END_RE = /^```\s*$/;

function classifyFence(lang: string, meta: string): ExtractedBlock['ext'] | null {
  if (/\bnoinclude\b/.test(meta)) {
    return null;
  }
  if (lang === 'ts' || lang === 'typescript') {
    return 'ts';
  }
  if (lang === 'tsx' || lang === 'jsx') {
    return 'tsx';
  }
  return null;
}

function extractBlocks(content: string): ExtractedBlock[] {
  const lines = content.split('\n');
  const blocks: ExtractedBlock[] = [];
  let activeExt: ExtractedBlock['ext'] | null = null;
  let currentBlock: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (activeExt === null) {
      const open = FENCE_OPEN_RE.exec(trimmed);
      if (!open) {
        continue;
      }
      const ext = classifyFence(open[1] ?? '', open[2] ?? '');
      if (!ext) {
        continue;
      }
      activeExt = ext;
      currentBlock = [];
      continue;
    }
    if (FENCE_END_RE.test(trimmed)) {
      if (currentBlock.length > 0) {
        blocks.push({
          code: currentBlock.join('\n'),
          ext: activeExt,
        });
      }
      activeExt = null;
      continue;
    }
    currentBlock.push(line);
  }

  return blocks;
}

//#endregion

//#region Homepage extraction

const HOMEPAGE_TEMPLATE_RE = /[=:]\s*`((?:\\.|[^`\\])*)`/g;
const HOMEPAGE_TS_HINT_RE = /\bimport\s/;
const HOMEPAGE_UNESCAPE_RE = /\\([`$])/g;

function extractHomepageBlocks(content: string): string[] {
  const blocks: string[] = [];
  HOMEPAGE_TEMPLATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = HOMEPAGE_TEMPLATE_RE.exec(content);
  while (match !== null) {
    const body = (match[1] ?? '').replace(HOMEPAGE_UNESCAPE_RE, '$1');
    if (HOMEPAGE_TS_HINT_RE.test(body)) {
      blocks.push(body);
    }
    match = HOMEPAGE_TEMPLATE_RE.exec(content);
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
  const blocks = extractBlocks(content);

  if (blocks.length === 0) {
    continue;
  }

  const relativePath = path.relative(CONTENT_DIR, mdxFile);
  const baseName = relativePath.replace(/[/\\]/g, '__').replace('.mdx', '');

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) {
      continue;
    }
    const fileName = `${baseName}__${i}.${block.ext}`;
    const outputPath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(outputPath, `${PREAMBLE}\n${block.code}\n`);
    snippetCount++;
  }
}

let homepageCount = 0;
for (const homepageFile of HOMEPAGE_FILES) {
  if (!fs.existsSync(homepageFile)) {
    continue;
  }
  const content = fs.readFileSync(homepageFile, 'utf-8');
  const blocks = extractHomepageBlocks(content);
  if (blocks.length === 0) {
    continue;
  }
  const baseName = `homepage__${path.basename(homepageFile).replace(/\.tsx$/, '')}`;
  for (let i = 0; i < blocks.length; i++) {
    const body = blocks[i];
    if (!body) {
      continue;
    }
    const fileName = `${baseName}__${i}.ts`;
    const outputPath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(outputPath, `${PREAMBLE}\n${body}\n`);
    homepageCount++;
  }
}

console.log(
  `Extracted ${snippetCount} doc snippets from ${mdxFiles.length} MDX files and ${homepageCount} homepage snippets.`,
);

//#endregion
