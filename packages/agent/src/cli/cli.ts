#!/usr/bin/env bun

/**
 * @noetic/agent CLI entry point.
 */

import { createClient } from '../ai/client.js';
import { runAgent } from '../tui/app.js';
import { parseArgs } from './args.js';

const config = parseArgs(process.argv);
const client = createClient(config.apiKey);

await runAgent(client, config);
