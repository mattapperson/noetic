#!/usr/bin/env bun

/**
 * @noetic/cli entry point.
 */

import { createLocalFsAdapter } from '@noetic/core';

import { discoverConfig, resolvePluginBaseDir } from '../config/discovery.js';
import { createPluginContextBuilder } from '../plugins/context.js';
import { loadPlugins } from '../plugins/loader.js';
import { findMostRecentSession, loadSession, loadSessionByIdAnywhere } from '../sessions/store.js';
import type { SessionFile } from '../sessions/types.js';
import { runAgent } from '../tui/app.js';
import type { AgentRuntimeConfig, CliFlags } from '../types/config.js';
import { parseArgs } from './args.js';

const { config: argsConfig, flags } = parseArgs(process.argv);
const discovered = await discoverConfig();
const baseConfig = discovered?.config ?? argsConfig;
const pluginBaseDir = discovered ? resolvePluginBaseDir(discovered.sourcePath) : baseConfig.cwd;
const buildCtx = createPluginContextBuilder(baseConfig);
const plugins = await loadPlugins(baseConfig, pluginBaseDir, buildCtx);

const initialSession = await resolveInitialSession(baseConfig.cwd, flags);

const runtimeConfig: AgentRuntimeConfig = {
  ...baseConfig,
  fs: createLocalFsAdapter(),
  // CLI `--model` wins over the saved session's model (user intent is explicit).
  model: argsConfig.model !== baseConfig.model ? argsConfig.model : baseConfig.model,
};

await runAgent(plugins, runtimeConfig, {
  initialSession,
  disablePersistence: flags.noSessionPersistence,
  name: flags.name,
});

async function resolveInitialSession(cwd: string, cliFlags: CliFlags): Promise<SessionFile | null> {
  const resumeTarget = cliFlags.resume;
  const wantContinue = cliFlags.continueLatest;

  if (!wantContinue && resumeTarget === false) {
    return null;
  }

  const loaded = await loadForResume(cwd, wantContinue, resumeTarget);
  if (!loaded) {
    return null;
  }

  if (loaded.cwd !== cwd) {
    process.stderr.write(
      `Warning: resuming session originally from ${loaded.cwd} (current cwd: ${cwd})\n`,
    );
  }

  if (cliFlags.forkSession) {
    return forkSession(loaded, cliFlags.sessionId);
  }
  return loaded;
}

async function loadForResume(
  cwd: string,
  wantContinue: boolean,
  resumeTarget: boolean | string,
): Promise<SessionFile | null> {
  if (wantContinue) {
    const latest = await findMostRecentSession(cwd);
    if (!latest) {
      process.stderr.write('No prior session for this cwd; starting fresh.\n');
      return null;
    }
    return latest;
  }
  if (typeof resumeTarget === 'string') {
    const direct =
      (await loadSession(cwd, resumeTarget)) ?? (await loadSessionByIdAnywhere(resumeTarget));
    if (!direct) {
      process.stderr.write(`Error: session ${resumeTarget} not found.\n`);
      process.exit(1);
    }
    return direct;
  }
  // --resume with no id: the picker ships in Phase 5. For now, fall back to
  // the most recent session for the cwd and warn.
  const latest = await findMostRecentSession(cwd);
  if (!latest) {
    process.stderr.write('No prior session for this cwd; starting fresh.\n');
    return null;
  }
  process.stderr.write(
    'Note: interactive picker not yet wired up — loading most recent session for this cwd.\n',
  );
  return latest;
}

function forkSession(source: SessionFile, forcedId: string | undefined): SessionFile {
  const nowIso = new Date().toISOString();
  return {
    ...source,
    sessionId: forcedId ?? crypto.randomUUID(),
    createdAt: nowIso,
    modifiedAt: nowIso,
  };
}
