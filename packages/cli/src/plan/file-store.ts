/**
 * Plan-file store: manages `~/.noetic/plans/<slug>/` session directories.
 *
 * Each session contains:
 *   - `plan.md`         — root PRD (markdown)
 *   - `flow.json`       — optional serialised noetic Step graph
 *   - `<nodeId>.md`     — optional per-node sub-plans referenced by IDs in flow.json
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { validateFlow } from './flow-schema.js';

//#region Types

export interface PlanSession {
  slug: string;
  dir: string;
}

export interface PlanSessionContents {
  prd: string | null;
  flow: unknown | null;
  subPlans: Record<string, string>;
}

//#endregion

//#region Constants

const ADJECTIVES = [
  'amber',
  'brisk',
  'clever',
  'dapper',
  'eager',
  'frosty',
  'gentle',
  'humble',
  'idle',
  'jolly',
  'keen',
  'lucid',
  'mellow',
  'noble',
  'quiet',
  'rapid',
  'sleek',
  'tidy',
  'vivid',
  'witty',
] as const;

const NOUNS_LEFT = [
  'arctic',
  'beacon',
  'cobalt',
  'delta',
  'ember',
  'forest',
  'glacier',
  'harbor',
  'island',
  'jasper',
  'kelp',
  'lagoon',
  'meadow',
  'nebula',
  'opal',
  'prairie',
] as const;

const NOUNS_RIGHT = [
  'falcon',
  'badger',
  'cheetah',
  'dolphin',
  'finch',
  'gecko',
  'heron',
  'iguana',
  'jackal',
  'koala',
  'lemur',
  'meerkat',
  'newt',
  'otter',
  'puffin',
  'quokka',
] as const;

const PLAN_FILE = 'plan.md';
const FLOW_FILE = 'flow.json';
const SUBPLAN_SUFFIX = '.md';

//#endregion

//#region Helpers

function pickRandom<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateWordSlug(): string {
  return [
    pickRandom(ADJECTIVES),
    pickRandom(NOUNS_LEFT),
    pickRandom(NOUNS_RIGHT),
  ].join('-');
}

const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assertSafeNodeId(nodeId: string): void {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error(
      `Invalid sub-plan node id "${nodeId}". Must match ${NODE_ID_PATTERN.source} (no path traversal).`,
    );
  }
}

function plansRoot(): string {
  // Honor a runtime override (used by tests + power users); fall back to $HOME
  // resolved per-call rather than the cached `os.homedir()` value.
  const override = process.env.NOETIC_PLANS_ROOT;
  if (override) {
    return override;
  }
  const home = process.env.HOME ?? homedir();
  return join(home, '.noetic', 'plans');
}

function sessionDir(slug: string): string {
  assertSafeNodeId(slug);
  return join(plansRoot(), slug);
}

//#endregion

//#region Public API

/** Creates a new session directory with a fresh adjective-noun-noun slug. */
export async function createPlanSession(): Promise<PlanSession> {
  const slug = generateWordSlug();
  const dir = sessionDir(slug);
  await mkdir(dir, {
    recursive: true,
  });
  return {
    slug,
    dir,
  };
}

export async function writePrd(slug: string, content: string): Promise<void> {
  const dir = sessionDir(slug);
  await mkdir(dir, {
    recursive: true,
  });
  await writeFile(join(dir, PLAN_FILE), content, 'utf8');
}

export async function writeSubPlan(slug: string, nodeId: string, content: string): Promise<void> {
  assertSafeNodeId(nodeId);
  const dir = sessionDir(slug);
  await mkdir(dir, {
    recursive: true,
  });
  await writeFile(join(dir, `${nodeId}${SUBPLAN_SUFFIX}`), content, 'utf8');
}

/** Validates `flowJson` against the flow schema, then writes it. Throws on invalid input. */
export async function writeFlow(slug: string, flowJson: unknown): Promise<void> {
  const validated = validateFlow(flowJson);
  const dir = sessionDir(slug);
  await mkdir(dir, {
    recursive: true,
  });
  await writeFile(join(dir, FLOW_FILE), JSON.stringify(validated, null, 2), 'utf8');
}

export async function readPlanSession(slug: string): Promise<PlanSessionContents> {
  const dir = sessionDir(slug);
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) {
    return {
      prd: null,
      flow: null,
      subPlans: {},
    };
  }

  const prd = entries.includes(PLAN_FILE) ? await readFile(join(dir, PLAN_FILE), 'utf8') : null;

  const flow = entries.includes(FLOW_FILE)
    ? JSON.parse(await readFile(join(dir, FLOW_FILE), 'utf8'))
    : null;

  const subPlans: Record<string, string> = {};
  for (const entry of entries) {
    if (entry === PLAN_FILE || !entry.endsWith(SUBPLAN_SUFFIX)) {
      continue;
    }
    const nodeId = entry.slice(0, -SUBPLAN_SUFFIX.length);
    subPlans[nodeId] = await readFile(join(dir, entry), 'utf8');
  }

  return {
    prd,
    flow,
    subPlans,
  };
}

export async function listPlanSessions(): Promise<string[]> {
  const root = plansRoot();
  const entries = await readdir(root, {
    withFileTypes: true,
  }).catch(() => null);
  if (entries === null) {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export function getPlanSessionDir(slug: string): string {
  return sessionDir(slug);
}

//#endregion
