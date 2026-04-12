#!/usr/bin/env bun

/**
 * @noetic/cli entry point.
 */

import { discoverConfig, resolvePluginBaseDir } from '../config/discovery.js';
import { disposePlugins, loadPlugins } from '../plugins/loader.js';
import { runAgent } from '../tui/app.js';
import { parseArgs } from './args.js';

const argsConfig = parseArgs(process.argv);
const discovered = await discoverConfig();
const config = discovered?.config ?? argsConfig;
const pluginBaseDir = discovered ? resolvePluginBaseDir(discovered.sourcePath) : config.cwd;
const plugins = await loadPlugins(config, pluginBaseDir);

try {
  await runAgent(plugins, config);
} finally {
  await disposePlugins(plugins);
}
