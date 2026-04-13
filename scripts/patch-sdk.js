#!/usr/bin/env node
// Adds compatibility shim for @openrouter/agent
import { writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  join(__dirname, '../node_modules/.bun/@openrouter+sdk@0.10.2/node_modules/@openrouter/sdk/esm/models'),
  join(__dirname, '../node_modules/.bun/@openrouter+sdk@0.5.1/node_modules/@openrouter/sdk/esm/models'),
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
