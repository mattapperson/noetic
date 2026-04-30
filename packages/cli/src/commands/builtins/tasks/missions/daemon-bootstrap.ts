import { createLocalFsAdapter } from '@noetic/core';

import { discoverConfig } from '../../../../config/discovery.js';
import { createAgentHarness } from '../../../../harness/factory.js';
import { createPluginContextBuilder } from '../../../../plugins/context.js';
import type { AgentConfig } from '../../../../types/config.js';
import { defaultSignaller } from '../agent-ci-control.js';
import type { AutopilotDeps } from './autopilot.js';

//#region Defaults

const DEFAULT_DAEMON_MAX_TURNS = 50;

const FALLBACK_MODEL = 'anthropic/claude-haiku-4-5-20251001';

//#endregion

//#region Helpers

function buildFallbackConfig(cwd: string): AgentConfig {
  return {
    model: FALLBACK_MODEL,
    cwd,
    apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
    maxTurns: DEFAULT_DAEMON_MAX_TURNS,
  };
}

async function loadDaemonAgentConfig(cwd: string): Promise<AgentConfig> {
  const discovered = await discoverConfig();
  if (!discovered) {
    return buildFallbackConfig(cwd);
  }
  return {
    ...discovered.config,
    cwd,
  };
}

//#endregion

//#region Public API

/**
 * @public
 * Constructs the long-lived dependencies bag used by every mission daemon job
 * (autopilot, validator, health). The harness is created once per daemon
 * process; jobs reuse it across ticks to avoid the per-tick LSP/skill
 * bootstrap cost.
 */
export async function buildMissionDaemonDeps(cwd: string): Promise<AutopilotDeps> {
  const fs = createLocalFsAdapter();
  const config = await loadDaemonAgentConfig(cwd);
  const buildContext = createPluginContextBuilder(config);
  const created = await createAgentHarness({
    config,
    plugins: [],
    fs,
    buildContext,
    mode: 'normal',
  });
  return {
    cwd,
    fs,
    signaller: defaultSignaller,
    missionHarness: created.harness,
    model: config.model,
  };
}

//#endregion
