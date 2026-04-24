#!/usr/bin/env bun

/**
 * @noetic/cli entry point.
 */

import { createLocalFsAdapter } from '@noetic/core';
import { discoverConfig, resolvePluginBaseDir } from '../config/discovery.js';
import { createPluginContextBuilder } from '../plugins/context.js';
import { loadPlugins } from '../plugins/loader.js';
import { runAgent } from '../tui/app.js';
import type { AgentRuntimeConfig } from '../types/config.js';
import { parseArgs } from './args.js';

const argsConfig = parseArgs(process.argv);
const discovered = await discoverConfig();
const baseConfig = discovered?.config ?? argsConfig;
const pluginBaseDir = discovered ? resolvePluginBaseDir(discovered.sourcePath) : baseConfig.cwd;
const buildCtx = createPluginContextBuilder(baseConfig);
const plugins = await loadPlugins(baseConfig, pluginBaseDir, buildCtx);

const runtimeConfig: AgentRuntimeConfig = {
  ...baseConfig,
  fs: createLocalFsAdapter(),
};

await runAgent(plugins, runtimeConfig);
