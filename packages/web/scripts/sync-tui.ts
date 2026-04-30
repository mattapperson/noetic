#!/usr/bin/env bun
/**
 * sync-tui — capture the live Noetic CLI through pilotty, parse it, and emit
 * structured snapshot data the marketing-page components import from.
 *
 * Usage:
 *   bun run sync-tui                full capture, including /context (sends 1 LLM turn, ~$0.01)
 *   bun run sync-tui:chrome         hero chrome only — no API calls, preserves existing context
 *   bun run sync-tui:check          fail if generated file would differ from a fresh capture
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

//#region Types

interface PowerlineSegment {
  glyph: string;
  text: string;
  role: 'agent' | 'model' | 'cwd' | 'branch' | 'tokens' | 'percent' | 'unknown';
}

interface ContextRow {
  label: string;
  tokens: string;
  pct: number;
  color: 'magenta' | 'blue' | 'cyan' | 'green';
}

interface HeroChrome {
  powerline: PowerlineSegment[];
  promptPlaceholder: string;
  modeLabel: string;
  modelId: string;
}

interface ContextSnapshot {
  modelId: string;
  totalUsed: string;
  totalLimit: string;
  totalPct: number;
  overviewRows: ContextRow[];
  layerIds: string[];
}

interface FullSnapshot {
  capturedAt: string;
  cliCommit: string;
  hero: HeroChrome;
  context: ContextSnapshot | null;
}

//#endregion

//#region Pilotty wrapper

interface PilottyOptions {
  json?: boolean;
}

function pilotty(args: ReadonlyArray<string>, opts: PilottyOptions = {}): string {
  const result = spawnSync('pilotty', args, {
    encoding: 'utf-8',
    stdio: [
      'ignore',
      'pipe',
      'pipe',
    ],
  });
  if (result.status !== 0) {
    throw new Error(`pilotty ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  if (opts.json) {
    return result.stdout;
  }
  return result.stdout;
}

function snapshot(session: string, settleMs = 800): string {
  return pilotty([
    'snapshot',
    '-s',
    session,
    '-f',
    'text',
    '--settle',
    String(settleMs),
  ]);
}

function sendKey(session: string, key: string): void {
  pilotty([
    'key',
    '-s',
    session,
    key,
  ]);
}

function sendText(session: string, text: string): void {
  pilotty([
    'type',
    '-s',
    session,
    text,
  ]);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

//#endregion

//#region Parsers

const POWERLINE_GLYPHS = {
  N: 'agent',
  '*': 'model',
  '~': 'cwd',
  '±': 'branch',
  '#': 'tokens',
  '%': 'percent',
} as const;

function isKnownGlyph(g: string): g is keyof typeof POWERLINE_GLYPHS {
  return g in POWERLINE_GLYPHS;
}

function parsePowerline(line: string): PowerlineSegment[] {
  const cleaned = line.trim();
  const parts = cleaned.split(/\s+>\s+/);
  return parts.map((part) => {
    const trimmed = part.trim();
    const firstChar = trimmed.split(/\s+/)[0] ?? '';
    if (isKnownGlyph(firstChar)) {
      const text = trimmed.slice(firstChar.length).trim();
      return {
        glyph: firstChar,
        text,
        role: POWERLINE_GLYPHS[firstChar],
      };
    }
    return {
      glyph: trimmed,
      text: '',
      role: 'unknown',
    };
  });
}

function findPowerlineLine(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes(' > ') && /[N*~±#%]/.test(line)) {
      return line;
    }
  }
  return null;
}

function findPromptPlaceholder(text: string): string {
  const match = text.match(/❯([^\n]*)/);
  if (!match?.[1]) {
    return 'Type a message...';
  }
  return match[1].trim().replace(/^Type/, 'Type');
}

function findModeLabel(text: string): {
  mode: string;
  modelId: string;
} {
  const match = text.match(/^\s*(ACT|PLAN|EDIT)\s+([^\s]+)/m);
  if (!match?.[1] || !match[2]) {
    return {
      mode: 'ACT',
      modelId: 'anthropic/claude-sonnet-4',
    };
  }
  return {
    mode: match[1],
    modelId: match[2],
  };
}

function normalizePowerline(segments: PowerlineSegment[]): PowerlineSegment[] {
  // The cwd and branch reflect the developer's local environment. Replace
  // them with canonical demo values so the marketing page shows "~/my-project"
  // regardless of where sync-tui ran.
  return segments.map((seg) => {
    if (seg.role === 'cwd') {
      return {
        ...seg,
        text: '~/my-project',
      };
    }
    if (seg.role === 'branch') {
      return {
        ...seg,
        text: 'main*',
      };
    }
    return seg;
  });
}

function parseHeroChrome(text: string): HeroChrome {
  const powerlineLine = findPowerlineLine(text);
  const rawPowerline = powerlineLine ? parsePowerline(powerlineLine) : [];
  const placeholder = findPromptPlaceholder(text);
  const { mode, modelId } = findModeLabel(text);
  return {
    powerline: normalizePowerline(rawPowerline),
    promptPlaceholder: placeholder,
    modeLabel: mode,
    modelId,
  };
}

// The Ink layout uses fixed Box widths: label=18, tokens=8, pct=7. When the
// label is exactly 18 chars (e.g. "durable-task-state") it abuts the tokens
// column with no whitespace, defeating any \s-based regex. Parse by columns.
const LABEL_COL = 18;
const TOKEN_COL = 8;
const PCT_COL = 7;
const TOKEN_RE = /^(\d+(?:\.\d+)?[kKmM]?)$/;
const PCT_RE = /^(\d+\.\d+)%$/;
const BAR_RE = /^[█░]+$/;

function parseRowByColumns(line: string): ContextRow | null {
  if (line.length < LABEL_COL + TOKEN_COL + PCT_COL) {
    return null;
  }
  const label = line.slice(0, LABEL_COL).trim();
  const tokens = line.slice(LABEL_COL, LABEL_COL + TOKEN_COL).trim();
  const pctRaw = line.slice(LABEL_COL + TOKEN_COL, LABEL_COL + TOKEN_COL + PCT_COL).trim();
  const tail = line.slice(LABEL_COL + TOKEN_COL + PCT_COL).trim();
  if (!label || !TOKEN_RE.test(tokens) || !PCT_RE.test(pctRaw) || !BAR_RE.test(tail)) {
    return null;
  }
  return {
    label,
    tokens,
    pct: Number.parseFloat(pctRaw.slice(0, -1)),
    color: classifyRowColor(label),
  };
}

function classifyRowColor(label: string): ContextRow['color'] {
  if (label === 'System prompt') {
    return 'magenta';
  }
  if (label === 'Tools') {
    return 'blue';
  }
  if (label === 'Messages') {
    return 'green';
  }
  return 'cyan';
}

function parseContextOverview(text: string): ContextSnapshot | null {
  const lines = text.split('\n');
  let modelId = '';
  let totalUsed = '';
  let totalLimit = '';
  let totalPct = 0;
  const rows: ContextRow[] = [];

  for (const line of lines) {
    const modelMatch = line.match(/^Model\s+(\S+)/);
    if (modelMatch?.[1]) {
      modelId = modelMatch[1];
      continue;
    }
    const ctxMatch = line.match(
      /^Context\s+window\s+(\S+)\s+\/\s+(\S+)\s+tokens\s+\((\d+\.\d+)%\)/,
    );
    if (ctxMatch?.[1] && ctxMatch[2] && ctxMatch[3]) {
      totalUsed = ctxMatch[1];
      totalLimit = ctxMatch[2];
      totalPct = Number.parseFloat(ctxMatch[3]);
      continue;
    }
    const row = parseRowByColumns(line);
    if (row) {
      rows.push(row);
    }
  }

  if (!modelId || rows.length === 0) {
    return null;
  }

  const layerIds: string[] = rows
    .filter((r) => r.color === 'cyan' && r.label !== 'System prompt' && r.label !== 'Tools')
    .map((r) => r.label);

  return {
    modelId,
    totalUsed,
    totalLimit,
    totalPct,
    overviewRows: rows,
    layerIds,
  };
}

//#endregion

//#region Capture

function getRepoRoot(): string {
  // When invoked inside a worktree, walk up to the parent repo so the CLI
  // can spawn against the canonical node_modules tree. Worktrees create a
  // second tree and Ink + React duplicate-instance errors result.
  const result = spawnSync(
    'git',
    [
      'rev-parse',
      '--show-toplevel',
    ],
    {
      encoding: 'utf-8',
    },
  );
  return result.stdout.trim().replace(/\/\.worktrees\/[^/]+$/, '');
}

function getCliCommit(): string {
  const result = spawnSync(
    'git',
    [
      'rev-parse',
      '--short',
      'HEAD',
    ],
    {
      encoding: 'utf-8',
      cwd: getRepoRoot(),
    },
  );
  return result.stdout.trim() || 'unknown';
}

function getCliPath(): string {
  return resolve(getRepoRoot(), 'packages/cli/src/cli/cli.ts');
}

async function captureHero(session: string): Promise<HeroChrome> {
  pilotty([
    'spawn',
    '--name',
    session,
    '--cwd',
    getRepoRoot(),
    'bun',
    getCliPath(),
  ]);
  await sleep(4000);
  pilotty([
    'resize',
    '-s',
    session,
    '110',
    '32',
  ]);
  await sleep(500);
  const text = snapshot(session, 1500);
  if (process.env.SYNC_TUI_DEBUG) {
    console.log('--- raw snapshot ---');
    console.log(text);
    console.log('--- end ---');
  }
  return parseHeroChrome(text);
}

async function captureContext(session: string): Promise<ContextSnapshot | null> {
  sendText(session, 'list 3 short adjectives');
  sendKey(session, 'Enter');

  // Wait for the agent turn to land. We poll for the prompt placeholder
  // returning, which signals the streaming finished.
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const text = snapshot(session, 500);
    if (text.includes('Type a message') && !text.includes('Pondering')) {
      break;
    }
  }

  await sleep(1000);
  sendText(session, '/context');
  sendKey(session, 'Enter');
  await sleep(2500);
  const text = snapshot(session, 2000);
  return parseContextOverview(text);
}

//#endregion

//#region Emit

const HEADER = `// AUTO-GENERATED by \`bun run sync-tui\` — do not edit by hand.
// Re-run the sync after the Noetic CLI changes the surface this file describes.
`;

function emit(snap: FullSnapshot): string {
  const lines: string[] = [
    HEADER,
    `// Captured: ${snap.capturedAt}`,
    `// CLI commit: ${snap.cliCommit}`,
    '',
    'export interface PowerlineSegment {',
    '  glyph: string;',
    '  text: string;',
    "  role: 'agent' | 'model' | 'cwd' | 'branch' | 'tokens' | 'percent' | 'unknown';",
    '}',
    '',
    'export interface ContextRow {',
    '  label: string;',
    '  tokens: string;',
    '  pct: number;',
    "  color: 'magenta' | 'blue' | 'cyan' | 'green';",
    '}',
    '',
    'export interface HeroChrome {',
    '  powerline: ReadonlyArray<PowerlineSegment>;',
    '  promptPlaceholder: string;',
    '  modeLabel: string;',
    '  modelId: string;',
    '}',
    '',
    'export interface ContextSnapshot {',
    '  modelId: string;',
    '  totalUsed: string;',
    '  totalLimit: string;',
    '  totalPct: number;',
    '  overviewRows: ReadonlyArray<ContextRow>;',
    '  layerIds: ReadonlyArray<string>;',
    '}',
    '',
    `export const HERO_CHROME: HeroChrome = ${JSON.stringify(snap.hero, null, 2)} as const;`,
    '',
  ];
  if (snap.context) {
    lines.push(
      `export const CONTEXT_SNAPSHOT: ContextSnapshot = ${JSON.stringify(snap.context, null, 2)} as const;`,
    );
  } else {
    lines.push('export const CONTEXT_SNAPSHOT: ContextSnapshot | null = null;');
  }
  lines.push('');
  lines.push("// AUTO-GENERATED — re-run 'bun run sync-tui' to refresh.");
  lines.push('');
  return lines.join('\n');
}

//#endregion

//#region Main

interface CliFlags {
  chromeOnly: boolean;
  check: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): CliFlags {
  return {
    chromeOnly: argv.includes('--chrome-only'),
    check: argv.includes('--check'),
  };
}

function readExistingContext(): ContextSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(OUTPUT_PATH, 'utf-8');
  } catch {
    return null;
  }
  const match = raw.match(/CONTEXT_SNAPSHOT[^=]+=\s*(\{[\s\S]+?\})\s*as const;/);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return isContextSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isContextSnapshot(value: unknown): value is ContextSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'modelId' in value &&
    typeof value.modelId === 'string' &&
    'totalUsed' in value &&
    typeof value.totalUsed === 'string' &&
    'totalLimit' in value &&
    typeof value.totalLimit === 'string' &&
    'totalPct' in value &&
    typeof value.totalPct === 'number' &&
    'overviewRows' in value &&
    Array.isArray(value.overviewRows) &&
    'layerIds' in value &&
    Array.isArray(value.layerIds)
  );
}

const OUTPUT_PATH = resolve(import.meta.dir, '..', 'lib', 'noetic-tui-snapshots.generated.ts');

async function run(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const session = `noetic-sync-${Date.now()}`;

  console.log(`[sync-tui] Spawning Noetic CLI in session ${session}`);
  let hero: HeroChrome;
  let context: ContextSnapshot | null = null;
  try {
    hero = await captureHero(session);
    console.log(`[sync-tui] Captured hero chrome — ${hero.powerline.length} segments`);
    if (flags.chromeOnly || flags.check) {
      context = readExistingContext();
      if (context && flags.chromeOnly) {
        console.log(
          `[sync-tui] --chrome-only: preserved ${context.overviewRows.length} context rows from existing file`,
        );
      } else if (!context && flags.chromeOnly) {
        console.warn(
          '[sync-tui] --chrome-only: no existing context to preserve. Run without --chrome-only to capture it.',
        );
      }
    } else {
      console.log('[sync-tui] Driving /context (this will send one LLM turn)…');
      context = await captureContext(session);
      if (context) {
        console.log(
          `[sync-tui] Captured /context — ${context.overviewRows.length} rows, ${context.layerIds.length} layers`,
        );
      } else {
        console.warn('[sync-tui] /context capture failed — emitting hero only');
      }
    }
  } finally {
    try {
      pilotty([
        'kill',
        '-s',
        session,
      ]);
    } catch {
      // session may have died on its own
    }
  }

  const snap: FullSnapshot = {
    capturedAt: new Date().toISOString(),
    cliCommit: getCliCommit(),
    hero,
    context,
  };

  const output = emit(snap);

  if (flags.check) {
    let existing = '';
    try {
      existing = readFileSync(OUTPUT_PATH, 'utf-8');
    } catch {
      console.error('[sync-tui] No existing snapshot file — run without --check first.');
      process.exit(2);
    }
    // Strip volatile header lines (capturedAt) before diffing structure.
    const norm = (s: string): string => s.replace(/^\/\/ Captured:.*\n/m, '');
    if (norm(existing) === norm(output)) {
      console.log('[sync-tui] OK — committed snapshot matches the live CLI.');
      return;
    }
    console.error('[sync-tui] DRIFT — committed snapshot is stale.');
    console.error('  Run `bun run sync-tui` and commit the result.');
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT_PATH), {
    recursive: true,
  });
  writeFileSync(OUTPUT_PATH, output);
  console.log(`[sync-tui] Wrote ${OUTPUT_PATH}`);
}

await run();

//#endregion
