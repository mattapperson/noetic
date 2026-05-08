#!/usr/bin/env bun

/**
 * One-off rewrite: split `@noetic/core` imports that co-reference Node-only
 * adapter symbols into (a) the remaining `@noetic/core` import and (b) a new
 * `@noetic/platform-node` import. Also fixes bare `from '@noetic/core'`
 * imports that only referenced Node-only symbols.
 *
 * Removed here: createLocalFsAdapter, createLocalShellAdapter,
 * createLocalSubprocessAdapter, createFileStorage, createDurableOutboundQueue,
 * AgentIpcClient, AgentIpcServer, AskUserPendingFrame, AskUserStreamEvent,
 * LocalShellAdapter, CreateLocalShellAdapterOptions, ProcessSignaller,
 * SubprocessSignal, defaultProcessSignaller, HelloInfo, AgentIpcClientOpts,
 * AgentIpcServerOpts, ChatHistoryStore, IpcAskUserService, IpcHarness,
 * TaskLogEntry, TaskLogger, unlinkSocketSync,
 * CreateDurableOutboundQueueOptions, DurableFrameEntry, DurableOutboundQueue,
 * CreateFileStorageOptions, ClientFrame, ClientFrameSchema, ServerFrame,
 * ServerFrameSchema, AskUserPendingFrameSchema, encodeFrame, parseClientFrame,
 * parseServerFrame, PROTOCOL_VERSION, AgentHarnessContract,
 * CreateLocalSubprocessAdapterOptions.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PLATFORM_NODE_NAMES = new Set([
  'createLocalFsAdapter',
  'createLocalShellAdapter',
  'createLocalSubprocessAdapter',
  'createFileStorage',
  'createDurableOutboundQueue',
  'AgentIpcClient',
  'AgentIpcServer',
  'AskUserPendingFrame',
  'AskUserStreamEvent',
  'LocalShellAdapter',
  'CreateLocalShellAdapterOptions',
  'ProcessSignaller',
  'SubprocessSignal',
  'defaultProcessSignaller',
  'HelloInfo',
  'AgentIpcClientOpts',
  'AgentIpcServerOpts',
  'ChatHistoryStore',
  'IpcAskUserService',
  'IpcHarness',
  'TaskLogEntry',
  'TaskLogger',
  'unlinkSocketSync',
  'CreateDurableOutboundQueueOptions',
  'DurableFrameEntry',
  'DurableOutboundQueue',
  'CreateFileStorageOptions',
  'ClientFrame',
  'ClientFrameSchema',
  'ServerFrame',
  'ServerFrameSchema',
  'AskUserPendingFrameSchema',
  'encodeFrame',
  'parseClientFrame',
  'parseServerFrame',
  'PROTOCOL_VERSION',
  'AgentHarnessContract',
  'CreateLocalSubprocessAdapterOptions',
]);

// Match: import { A, type B, C } from '@noetic/core';
// Capture the specifier list (group 1) so we can split it.
const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]@noetic\/core['"];?/g;

function isPlatformNodeSpec(spec: string): boolean {
  const m = spec.trim().match(/^(?:type\s+)?(\w+)(?:\s+as\s+\w+)?$/);
  if (!m) {
    return false;
  }
  return PLATFORM_NODE_NAMES.has(m[1]);
}

function rewriteFile(path: string): boolean {
  const src = readFileSync(path, 'utf-8');
  let changed = false;
  const out = src.replace(importRe, (full, specList: string) => {
    const specs = specList
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const stay: string[] = [];
    const move: string[] = [];
    for (const s of specs) {
      if (isPlatformNodeSpec(s)) {
        move.push(s);
      } else {
        stay.push(s);
      }
    }
    if (move.length === 0) {
      return full;
    }
    changed = true;
    const parts: string[] = [];
    if (stay.length > 0) {
      parts.push(`import { ${stay.join(', ')} } from '@noetic/core';`);
    }
    parts.push(`import { ${move.join(', ')} } from '@noetic/platform-node';`);
    return parts.join('\n');
  });
  if (changed) {
    writeFileSync(path, out);
  }
  return changed;
}

// Find every ts/tsx in packages/cli + packages/code-agent that imports @noetic/core.
const filesOutput = execSync(
  `grep -rl "from '@noetic/core'" packages/cli packages/code-agent --include="*.ts" --include="*.tsx"`,
  {
    encoding: 'utf-8',
  },
);
const files = filesOutput.trim().split('\n').filter(Boolean);

let changed = 0;
for (const f of files) {
  if (rewriteFile(f)) {
    changed += 1;
  }
}
console.log(`Rewrote ${changed} file(s) out of ${files.length} candidates.`);
