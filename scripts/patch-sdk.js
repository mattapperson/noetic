#!/usr/bin/env node
// Adds compatibility shims for @openrouter/agent and @openrouter/sdk
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Shim 1: Export aliases for renamed types
const shimContent = `// Shim: re-export with old names for @openrouter/agent compatibility
export {
  OpenResponsesEasyInputMessageRoleAssistant as EasyInputMessageRoleAssistant,
  OpenResponsesEasyInputMessageRoleDeveloper as EasyInputMessageRoleDeveloper,
  OpenResponsesEasyInputMessageRoleSystem as EasyInputMessageRoleSystem,
  OpenResponsesEasyInputMessageRoleUser as EasyInputMessageRoleUser,
} from './openresponseseasyinputmessage.js';
`;

// Patch all SDK versions that might be resolved
const sdkPaths = [
  join(__dirname, '../node_modules/@openrouter/sdk/esm/models'),
  join(
    __dirname,
    '../node_modules/.bun/@openrouter+sdk@0.10.2/node_modules/@openrouter/sdk/esm/models',
  ),
  join(
    __dirname,
    '../node_modules/.bun/@openrouter+sdk@0.5.1/node_modules/@openrouter/sdk/esm/models',
  ),
];

for (const modelsDir of sdkPaths) {
  const jsPath = join(modelsDir, 'easyinputmessage.js');
  const dtsPath = join(modelsDir, 'easyinputmessage.d.ts');

  if (existsSync(modelsDir) && !existsSync(jsPath)) {
    writeFileSync(jsPath, shimContent);
    writeFileSync(dtsPath, shimContent);
    console.log(`Added @openrouter/sdk compatibility shim to ${modelsDir}`);
  }
}

// Shim 2: Fix responsesRequest -> openResponsesRequest mismatch between agent and SDK
// This is only needed when agent uses one name but the SDK it resolves to uses another
const agentPaths = [
  join(__dirname, '../node_modules/@openrouter/agent'),
  join(__dirname, '../node_modules/.bun/@openrouter+agent@0.3.0/node_modules/@openrouter/agent'),
  join(__dirname, '../node_modules/.bun/@openrouter+agent@0.3.1/node_modules/@openrouter/agent'),
  join(__dirname, '../node_modules/.bun/@openrouter+agent@0.6.0/node_modules/@openrouter/agent'),
];

for (const agentPath of agentPaths) {
  const modelResultPath = join(agentPath, 'esm/lib/model-result.js');
  if (!existsSync(modelResultPath)) {
    continue;
  }

  // Find which SDK version this agent resolves to
  const agentPkg = JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf-8'));
  const sdkVersion = agentPkg.dependencies?.['@openrouter/sdk'];

  // Check what the resolved SDK expects
  let sdkExpectsOpen = false;
  const sdkCheckPaths = [
    join(agentPath, 'node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.d.ts'),
    join(
      __dirname,
      `../node_modules/.bun/@openrouter+sdk@${sdkVersion?.replace('^', '')}/node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.d.ts`,
    ),
    join(__dirname, '../node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.d.ts'),
  ];

  for (const sdkPath of sdkCheckPaths) {
    if (existsSync(sdkPath)) {
      const sdkContent = readFileSync(sdkPath, 'utf-8');
      sdkExpectsOpen = sdkContent.includes('openResponsesRequest:');
      break;
    }
  }

  let content = readFileSync(modelResultPath, 'utf-8');
  const agentUsesResponses =
    content.includes('responsesRequest:') && !content.includes('openResponsesRequest:');
  const agentUsesOpen = content.includes('openResponsesRequest:');

  if (sdkExpectsOpen && agentUsesResponses) {
    content = content.replace(/responsesRequest:/g, 'openResponsesRequest:');
    writeFileSync(modelResultPath, content);
    console.log(`Fixed responsesRequest -> openResponsesRequest in ${modelResultPath}`);
  } else if (!sdkExpectsOpen && agentUsesOpen) {
    content = content.replace(/openResponsesRequest:/g, 'responsesRequest:');
    writeFileSync(modelResultPath, content);
    console.log(`Fixed openResponsesRequest -> responsesRequest in ${modelResultPath}`);
  }
}

// Shim 3: Remove duplicate keys from @openrouter/sdk tsconfig.json.
// Upstream ships with "rootDir" declared twice, which makes Bun emit a
// "Duplicate key" warning every time it resolves the package. The warning
// is buffered while a TUI owns the terminal and flushes on exit (e.g. Ctrl+C).
const tsconfigPaths = [
  join(__dirname, '../node_modules/@openrouter/sdk/tsconfig.json'),
  join(
    __dirname,
    '../node_modules/.bun/@openrouter+sdk@0.12.0/node_modules/@openrouter/sdk/tsconfig.json',
  ),
  join(
    __dirname,
    '../node_modules/.bun/@openrouter+sdk@0.10.2/node_modules/@openrouter/sdk/tsconfig.json',
  ),
  join(
    __dirname,
    '../node_modules/.bun/@openrouter+sdk@0.5.1/node_modules/@openrouter/sdk/tsconfig.json',
  ),
];

for (const tsconfigPath of tsconfigPaths) {
  if (!existsSync(tsconfigPath)) {
    continue;
  }
  const original = readFileSync(tsconfigPath, 'utf-8');
  const deduped = dedupeJsoncKeys(original);
  if (deduped === original) {
    continue;
  }
  writeFileSync(tsconfigPath, deduped);
  console.log(`Removed duplicate keys from ${tsconfigPath}`);
}

// Removes lines that repeat a `"key":` already seen at the same brace depth.
// Preserves comments and formatting so the file still reads naturally.
function dedupeJsoncKeys(source) {
  const lines = source.split('\n');
  const seenByDepth = [
    new Set(),
  ];
  let depth = 0;
  const kept = [];

  for (const line of lines) {
    const keyMatch = line.match(/^\s*"([^"]+)"\s*:/);
    if (keyMatch) {
      const key = keyMatch[1];
      const seen = seenByDepth[depth];
      if (seen?.has(key)) {
        continue;
      }
      seen?.add(key);
    }

    for (const char of line) {
      if (char === '{' || char === '[') {
        depth += 1;
        seenByDepth[depth] = new Set();
        continue;
      }
      if (char === '}' || char === ']') {
        seenByDepth[depth] = undefined;
        depth = Math.max(0, depth - 1);
      }
    }

    kept.push(line);
  }

  return kept.join('\n');
}
