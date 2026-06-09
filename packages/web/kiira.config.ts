import { defineConfig } from 'kiira-core';

/**
 * Kiira validates the TypeScript/TSX code fences in the docs site against the
 * real `@noetic-tools/core` source (mapped via tsconfig.kiira.json paths), so
 * documentation examples cannot drift from the public API.
 *
 * The fence → preamble logic lives in `scripts/check-docs.ts` (the runner),
 * because the preamble must be applied *conditionally*: fences that bring their
 * own `@noetic-tools/*` imports are checked standalone, while bare snippet
 * fences get the shared import/declaration preamble injected. Kiira's own
 * `defaultFixture` is unconditional, so it cannot express that rule.
 */
export default defineConfig({
  include: [
    'content/**/*.mdx',
  ],
  exclude: [
    '**/node_modules/**',
  ],
  tsconfig: 'tsconfig.kiira.json',
  // Resolve module imports via tsconfig `paths`, not workspace package.json
  // (core ships no built dist in the repo).
  packageMode: 'packed',
  defaultValidate: 'type',
  languages: [
    'ts',
    'tsx',
  ],
});
