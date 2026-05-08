/**
 * `@noetic/platform-browser` — browser / edge-runtime adapter glue.
 *
 * Core ships only contracts + in-memory adapters. This package
 * re-exports those for ergonomic imports in browser-targeting code.
 *
 * For a Mirage-backed VFS, consumers install `@noetic/mirage`
 * directly — the bridge is runtime-neutral and does not need to be
 * re-exported here.
 *
 * No `node:*` imports live here. Bundlers targeting browsers resolve
 * this package cleanly without polyfills.
 */

// Re-exports of core's runtime-neutral adapters.
export {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
} from '@noetic/core';
