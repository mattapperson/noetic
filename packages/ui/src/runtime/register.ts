/**
 * Side-effect module that registers the UI trace exporter with @noetic/core.
 *
 * When NOETIC_UI_ENABLED=true, this registers a factory so that AgentHarness
 * automatically streams traces to the UI server — no code change required.
 */

import { registerExporterFactory } from '@noetic/core';
import { NoeticUITraceExporter } from './exporter';

if (process.env.NOETIC_UI_ENABLED === 'true') {
  registerExporterFactory(
    () =>
      new NoeticUITraceExporter({
        port: Number(process.env.NOETIC_UI_WS_PORT) || 3333,
        host: process.env.NOETIC_UI_HOST || 'localhost',
      }),
  );
}
