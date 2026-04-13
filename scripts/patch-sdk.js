#!/usr/bin/env node
// Adds compatibility shims for @openrouter/agent and @openrouter/sdk
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

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
  join(scriptsDir, '../node_modules/@openrouter/sdk/esm/models'),
  join(
    scriptsDir,
    '../node_modules/.bun/@openrouter+sdk@0.10.2/node_modules/@openrouter/sdk/esm/models',
  ),
  join(
    scriptsDir,
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
  join(scriptsDir, '../node_modules/@openrouter/agent'),
  join(scriptsDir, '../node_modules/.bun/@openrouter+agent@0.3.0/node_modules/@openrouter/agent'),
  join(scriptsDir, '../node_modules/.bun/@openrouter+agent@0.3.1/node_modules/@openrouter/agent'),
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
      scriptsDir,
      `../node_modules/.bun/@openrouter+sdk@${sdkVersion?.replace('^', '')}/node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.d.ts`,
    ),
    join(scriptsDir, '../node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.d.ts'),
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
