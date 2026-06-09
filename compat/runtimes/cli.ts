/**
 * Shared CLI entry for the Node, Bun, and Deno targets. Bun and Deno execute
 * this TypeScript file directly; Node executes a bundled copy (see
 * `scripts/build-bundles.ts`). The runtime is auto-detected inside `main()`.
 */

import { main } from '../shared/cli-entry.js';

await main();
