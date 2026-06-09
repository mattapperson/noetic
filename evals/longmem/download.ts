#!/usr/bin/env bun
/**
 * Downloads the smallest LongMemEval split (the `oracle` variant) into
 * `evals/longmem/data/`. The oracle split contains only the evidence sessions
 * per question (~15 MB), making it the cheapest dataset to run an agent on.
 *
 * Data is sourced from the maintained "cleaned" release; the original
 * `xiaowu0162/longmemeval` repo is deprecated.
 *
 * Usage: bun evals/longmem/download.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ORACLE_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json';

const OUT_DIR = path.join(import.meta.dir, 'data');
const OUT_FILE = path.join(OUT_DIR, 'longmemeval_oracle.json');

async function main(): Promise<void> {
  if (fs.existsSync(OUT_FILE)) {
    const sizeMb = (fs.statSync(OUT_FILE).size / 1e6).toFixed(1);
    console.log(`Already downloaded: ${OUT_FILE} (${sizeMb} MB)`);
    return;
  }

  fs.mkdirSync(OUT_DIR, {
    recursive: true,
  });
  console.log(`Downloading LongMemEval (oracle) from:\n  ${ORACLE_URL}`);

  const response = await fetch(ORACLE_URL);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  fs.writeFileSync(OUT_FILE, buffer);
  const sizeMb = (buffer.byteLength / 1e6).toFixed(1);
  console.log(`Saved ${sizeMb} MB to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
