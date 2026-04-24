/**
 * Explicit opt-in for Noetic dev UI integration.
 *
 * Call enableDevUI() once in your entry point to register the trace exporter
 * and built-in step data extractors. Without this call, no dev UI code executes
 * and the entire module graph is tree-shakeable from production builds.
 *
 * Must be called before AgentHarness resolves its exporter (i.e., before first run).
 *
 * @example
 * ```typescript
 * import { enableDevUI } from '@noetic/ui/runtime/enable';
 *
 * if (process.env.NOETIC_UI_ENABLED === 'true') {
 *   enableDevUI({ port: 3333 });
 * }
 * ```
 */

import { clearExporterFactory, registerExporterFactory } from '@noetic/core';
import { NoeticUITraceExporter } from './exporter';
import {
  clearStepDataExtractors,
  registerBuiltinExtractors,
  resetBuiltinsGuard,
} from './step-extractors';
import type { ExporterOptions } from './types';

let enabled = false;

/**
 * Reset the enabled guard so enableDevUI() can be called again.
 * For testing only.
 */
export function resetEnabledGuard(): void {
  enabled = false;
}

/**
 * Enable the Noetic dev UI integration.
 *
 * Registers built-in step data extractors and the UI trace exporter factory.
 * Idempotent — calling more than once warns and returns a no-op handle.
 *
 * @param options - Optional exporter configuration (port, host, agentName, etc.)
 * @returns A handle with a `disable()` method for cleanup/testing
 */
export function enableDevUI(options?: ExporterOptions): {
  disable(): void;
} {
  if (enabled) {
    console.warn('[noetic-ui] enableDevUI() already called — ignoring.');
    return {
      disable() {},
    };
  }
  enabled = true;

  registerBuiltinExtractors();
  registerExporterFactory(() => new NoeticUITraceExporter(options));

  return {
    disable(): void {
      clearExporterFactory();
      clearStepDataExtractors();
      resetBuiltinsGuard();
      enabled = false;
    },
  };
}
