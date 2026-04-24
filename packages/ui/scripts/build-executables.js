#!/usr/bin/env node
/**
 * Build script for creating standalone executables
 * Uses Bun's --compile flag to bundle everything into a single binary
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist-exe');

// Platform configurations
const platforms = [
  {
    os: 'linux',
    arch: 'x64',
    target: 'bun-linux-x64',
    ext: '',
  },
  {
    os: 'linux',
    arch: 'arm64',
    target: 'bun-linux-arm64',
    ext: '',
  },
  {
    os: 'darwin',
    arch: 'x64',
    target: 'bun-darwin-x64',
    ext: '',
  },
  {
    os: 'darwin',
    arch: 'arm64',
    target: 'bun-darwin-arm64',
    ext: '',
  },
  {
    os: 'win32',
    arch: 'x64',
    target: 'bun-windows-x64',
    ext: '.exe',
  },
];

// Check if running with Bun
const isBun = process.versions.bun !== undefined;

if (!isBun) {
  console.error('❌ This build script requires Bun.');
  console.error('   Install: https://bun.sh');
  console.error('   Then run: bun scripts/build-executables.js');
  process.exit(1);
}

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, {
    recursive: true,
  });
}

const entryPoint = join(rootDir, 'src', 'service', 'index.ts');

console.log('🔨 Building Noetic UI executables...\n');

let successCount = 0;
let failCount = 0;

for (const platform of platforms) {
  const filename = `noetic-ui-${platform.os}-${platform.arch}${platform.ext}`;
  const outputPath = join(distDir, filename);

  console.log(`Building ${platform.os}-${platform.arch}...`);
  console.log(`  Output: ${filename}`);

  try {
    // Build with Bun
    const cmd = [
      'bun',
      'build',
      '--compile',
      '--target',
      platform.target,
      '--outfile',
      outputPath,
      entryPoint,
    ].join(' ');

    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit',
    });

    console.log('  ✅ Success\n');
    successCount++;
  } catch (error) {
    console.error(`  ❌ Failed: ${error.message}\n`);
    failCount++;
  }
}

console.log('\n' + '='.repeat(50));
console.log(`Build complete: ${successCount} succeeded, ${failCount} failed`);
console.log(`Output directory: ${distDir}`);
console.log('\nExecutables:');

for (const platform of platforms) {
  const filename = `noetic-ui-${platform.os}-${platform.arch}${platform.ext}`;
  const outputPath = join(distDir, filename);
  if (existsSync(outputPath)) {
    console.log(`  ✓ ${filename}`);
  }
}

if (failCount > 0) {
  console.log('\n⚠️  Some builds failed. Check errors above.');
  process.exit(1);
} else {
  console.log('\n✅ All builds successful!');
  process.exit(0);
}
