/**
 * Interactive TUI bootstrap — the default entry path.
 *
 * Parses args, loads config + plugins, resolves any resumed session, runs
 * the binary-availability setup flow, installs the interrupt safety net,
 * and hands control to the Ink app.
 */

import { createLocalFsAdapter } from '@noetic/platform-node';

import { discoverConfig, resolvePluginBaseDir } from '../config/discovery.js';
import { createPluginContextBuilder } from '../plugins/context.js';
import { loadPlugins } from '../plugins/loader.js';
import { findMostRecentSession, loadSession, loadSessionByIdAnywhere } from '../sessions/store.js';
import { runAgent } from '../tui/app.js';
import { runPicker } from '../tui/run-picker.js';
import { installInterruptSafetyNet } from '../tui/terminal/interrupt-safety-net.js';
import type { AgentRuntimeConfig, CliFlags } from '../types/config.js';
import type { SessionFile } from '../types/session.js';
import { parseArgs } from './args.js';
import { composeRuntimeModel } from './compose-runtime-config.js';
import { runSetupFlow } from './run-setup-flow.js';

export async function runInteractiveEntry(argv: string[]): Promise<void> {
  const { config: argsConfig, flags } = parseArgs(argv);
  const discovered = await discoverConfig();
  const baseConfig = discovered?.config ?? argsConfig;
  const pluginBaseDir = discovered ? resolvePluginBaseDir(discovered.sourcePath) : baseConfig.cwd;
  const buildCtx = createPluginContextBuilder(baseConfig);
  const plugins = await loadPlugins(baseConfig, pluginBaseDir, buildCtx);

  const initialSession = await resolveInitialSession(baseConfig.cwd, flags);

  // Plugin discovery (above) intentionally uses the launch cwd; only the
  // harness follows a resumed session's saved cwd so file ops land in the
  // session's original project.
  const runtimeCwd = initialSession?.cwd ?? baseConfig.cwd;

  // Interactive check for the binaries the agent's tools depend on (rtk,
  // pilotty, agent-browser). If any are missing and not ignored, this renders
  // a pre-TUI setup screen; in non-TTY mode it emits one stderr notice per
  // missing binary and proceeds. The returned map tells the harness which
  // tools to drop or degrade.
  const binaryAvailability = await runSetupFlow({
    config: baseConfig,
  });

  const runtimeConfig: AgentRuntimeConfig = {
    ...baseConfig,
    cwd: runtimeCwd,
    fs: createLocalFsAdapter(),
    model: composeRuntimeModel({
      cliModel: argsConfig.model,
      modelExplicit: flags.modelExplicit,
      sessionModel: initialSession?.model,
      configFileModel: discovered?.config.model,
    }),
    binaryAvailability,
  };

  installInterruptSafetyNet({
    on: (signal, handler) => {
      process.on(signal, handler);
    },
    off: (signal, handler) => {
      process.off(signal, handler);
    },
    exit: (code) => process.exit(code),
    stdout: process.stdout,
    setRawMode:
      process.stdin.isTTY && typeof process.stdin.setRawMode === 'function'
        ? (raw) => process.stdin.setRawMode(raw)
        : undefined,
  });

  await runAgent(plugins, runtimeConfig, {
    initialSession,
    disablePersistence: flags.noSessionPersistence,
    name: flags.name,
    forcedSessionId: flags.sessionId,
  });
}

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
    process.stderr.write(`Resuming from ${loaded.cwd}; switched there (launched from ${cwd}).\n`);
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
  // --resume with no id: open the interactive picker.
  const picked = await runPicker(cwd);
  if (picked === null) {
    // User pressed Esc — exit cleanly.
    process.exit(0);
  }
  return picked;
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
