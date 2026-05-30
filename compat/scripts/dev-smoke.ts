/**
 * Quick local validation of the shared smoke against the workspace packages.
 * Not part of the deployment matrix — used to iterate on the smoke logic with
 * fast feedback before the packaging pipeline is wired up.
 *
 * Run from the repo root: `bun compat/scripts/dev-smoke.ts`
 */

import { runSmoke } from '../shared/smoke.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(1);
}

const result = await runSmoke({
  runtime: 'bun',
  apiKey,
  model: process.env.NOETIC_COMPAT_MODEL,
});

console.log(JSON.stringify(result, null, 2));
