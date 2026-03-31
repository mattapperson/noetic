#!/usr/bin/env node
/**
 * Noetic UI CLI
 *
 * Usage: npx @noetic/ui [command]
 *
 * Commands:
 *   serve    Start the WebSocket server and serve the UI (default)
 *   help     Show usage information
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] || 'serve';

const PORT_WS = Number.parseInt(process.env.NOETIC_UI_WS_PORT || '3333', 10);
const PORT_API = Number.parseInt(process.env.NOETIC_UI_API_PORT || '3334', 10);
const HOST = process.env.NOETIC_UI_HOST || '127.0.0.1';

console.log('🔮 Noetic UI');
console.log('');

if (command === 'serve' || command === 'start') {
  console.log('Starting server...');
  console.log(`WebSocket: ws://${HOST}:${PORT_WS}`);
  console.log(`Web UI: http://${HOST}:${PORT_API}`);
  console.log('');

  // Determine if we're running with Bun or Node
  const isBun = process.versions.bun !== undefined;
  const serverScript = join(__dirname, '..', 'src', 'service', 'index.ts');

  console.log(`Using ${isBun ? 'Bun' : 'Node'} runtime`);
  console.log(`Server script: ${serverScript}`);
  console.log('');

  // Set environment variables for the server
  const env = {
    ...process.env,
    NOETIC_UI_WS_PORT: String(PORT_WS),
    NOETIC_UI_API_PORT: String(PORT_API),
    NOETIC_UI_HOST: HOST,
  };

  let child;
  if (isBun) {
    // Bun can run TypeScript directly
    child = spawn(
      'bun',
      [
        'run',
        serverScript,
      ],
      {
        stdio: 'inherit',
        env,
      },
    );
  } else {
    // Node needs ts-node or similar - for now, instruct user to use Bun
    console.error('❌ This package requires Bun to run the server.');
    console.log('');
    console.log('Please install Bun: https://bun.sh');
    console.log('Then run: bunx @noetic/ui serve');
    console.log('');
    console.log('Alternatively, run directly with Bun:');
    console.log('  bun run src/service/index.ts');
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    child.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log('Usage: npx @noetic/ui [command]');
  console.log('');
  console.log('Commands:');
  console.log('  serve    Start the WebSocket server and serve the UI (default)');
  console.log('  help     Show this help message');
  console.log('');
  console.log('Environment variables:');
  console.log('  NOETIC_UI_WS_PORT    WebSocket server port (default: 3333)');
  console.log('  NOETIC_UI_API_PORT   Web UI port (default: 3334)');
  console.log('  NOETIC_UI_HOST       Bind address (default: 127.0.0.1)');
  console.log('');
  console.log('Note: This package requires Bun runtime.');
  console.log('Install Bun from: https://bun.sh');
} else {
  console.error(`Unknown command: ${command}`);
  console.log('Run `npx @noetic/ui help` for usage information');
  process.exit(1);
}
