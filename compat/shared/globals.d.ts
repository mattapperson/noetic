/**
 * Minimal ambient typings for the non-Node runtime globals the smoke entries
 * probe. Declared on `globalThis` (via `var`) so they can be accessed safely as
 * `globalThis.Deno` — referencing a bare `Deno` identifier under Node/Bun would
 * throw a ReferenceError, whereas the property access simply yields `undefined`.
 */

import type { SmokeResult } from './types.js';

declare global {
  // eslint-disable-next-line no-var
  var Deno:
    | {
        env: {
          get(key: string): string | undefined;
        };
        exit(code: number): never;
      }
    | undefined;

  /** Globals exchanged between the browser harness and the in-page bundle. */
  interface Window {
    __OPENROUTER_API_KEY__?: string;
    __NOETIC_COMPAT_MODEL__?: string;
    __noeticSmoke?:
      | {
          status: 'pending';
        }
      | {
          status: 'ok';
          result: SmokeResult;
        }
      | {
          status: 'error';
          error: string;
        };
  }
}
