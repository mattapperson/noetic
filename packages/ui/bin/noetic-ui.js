#!/usr/bin/env node
/**
 * Noetic UI CLI
 *
 * This script checks if Bun is available and either runs the server directly,
 * or provides instructions to download the standalone executable.
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

// Detect OS and architecture for executable download
function getPlatformInfo() {
  const os = process.platform;
  const arch = process.arch;

  const osMap = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  };

  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
  };

  const mappedOs = osMap[os] || os;
  const mappedArch = archMap[arch] || arch;
  const ext = os === 'win32' ? '.exe' : '';

  return {
    os: mappedOs,
    arch: mappedArch,
    filename: `noetic-ui-${mappedOs}-${mappedArch}${ext}`,
  };
}

if (command === 'serve' || command === 'start') {
  // Determine if we're running with Bun or Node
  const isBun = process.versions.bun !== undefined;
  const serverScript = join(__dirname, '..', 'src', 'service', 'index.ts');

  if (!isBun) {
    // Not running with Bun - guide user to download executable
    const platform = getPlatformInfo();

    console.log('⚠️  Bun runtime not detected.');
    console.log('');
    console.log('Noetic UI is easiest to run as a standalone executable:');
    console.log('');
    console.log('📥 Quick Install (recommended):');
    console.log(
      '   curl -fsSL https://raw.githubusercontent.com/mattapperson/noetic/main/packages/ui/scripts/install.sh | bash',
    );
    console.log('');
    console.log('📦 Or download manually:');
    console.log(
      `   https://github.com/mattapperson/noetic/releases/latest/download/${platform.filename}`,
    );
    console.log('');
    console.log('🔧 Development setup (requires Bun):');
    console.log('   1. Install Bun: https://bun.sh');
    console.log('   2. Run: bunx @noetic/ui serve');
    console.log('');
    console.log('🐳 Or use Docker:');
    console.log('   docker run -p 3333:3333 -p 3334:3334 noetic/ui');
    console.log('');

    process.exit(1);
  }

  // Bun is available - run the server
  console.log('Starting server...');
  console.log(`WebSocket: ws://${HOST}:${PORT_WS}`);
  console.log(`Web UI: http://${HOST}:${PORT_API}`);
  console.log('');
  console.log('Using Bun runtime');
  console.log(`Server script: ${serverScript}`);
  console.log('');

  // Set environment variables for the server
  const env = {
    ...process.env,
    NOETIC_UI_WS_PORT: String(PORT_WS),
    NOETIC_UI_API_PORT: String(PORT_API),
    NOETIC_UI_HOST: HOST,
  };

  const child = spawn(
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
  console.log('Installation options:');
  console.log('');
  console.log('  1. Standalone executable (recommended):');
  console.log(
    '     curl -fsSL https://raw.githubusercontent.com/mattapperson/noetic/main/packages/ui/scripts/install.sh | bash',
  );
  console.log('');
  console.log('  2. npm/yarn/pnpm (requires Bun runtime):');
  console.log('     npx @noetic/ui serve');
  console.log('');
  console.log('  3. Docker:');
  console.log('     docker run -p 3333:3333 -p 3334:3334 noetic/ui');
  console.log('');
  console.log('Documentation: https://github.com/mattapperson/noetic/tree/main/packages/ui');
} else {
  console.error(`Unknown command: ${command}`);
  console.log('Run `npx @noetic/ui help` for usage information');
  process.exit(1);
}
