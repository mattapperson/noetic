/**
 * The `agentPlugins()` context layer: progressive disclosure, budget
 * degradation, anchored placement, and spawn semantics.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@noetic-tools/types';
import { Slot } from '@noetic-tools/types';
import { z } from 'zod';
import type { AgentPluginsLayer, AgentPluginsState } from '../src/layer/agent-plugins';
import { agentPlugins } from '../src/layer/agent-plugins';
import {
  cleanupFixtures,
  fakeExecutionContext,
  makePluginRoot,
  manifest,
  mcpConfig,
  skillDoc,
} from './_helpers';

afterAll(cleanupFixtures);

//#region Harness

/**
 * Narrow a `provides` entry to a callable function declaration. The contract
 * types `provides` as a union of data and function declarations, so tests have
 * to discriminate before invoking one.
 */
const StateSchema = z.object({
  activated: z.array(z.string()),
});

/** Narrow the `unknown` state a function declaration returns back to this layer's state. */
function asState(value: unknown): AgentPluginsState | undefined {
  const parsed = StateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

interface FunctionOutcome {
  result: unknown;
  state: AgentPluginsState | undefined;
}

function fn(
  layer: AgentPluginsLayer,
  name: string,
): (
  args: Record<string, unknown>,
  state: AgentPluginsState,
  ctx: ExecutionContext,
) => Promise<FunctionOutcome> {
  const decl = layer.provides?.[name];
  if (decl === undefined || decl.kind !== 'function') {
    throw new Error(`layer does not expose a '${name}' function`);
  }
  return async (args, state, ctx) => {
    const outcome = await decl.execute(args, state, ctx);
    return {
      result: outcome.result,
      state: asState(outcome.state),
    };
  };
}

function data(layer: AgentPluginsLayer, name: string, state: AgentPluginsState): unknown {
  const decl = layer.provides?.[name];
  if (decl === undefined || decl.kind !== 'data') {
    throw new Error(`layer does not expose '${name}' data`);
  }
  return decl.read(state);
}

/** Run `init` and return the layer's starting state plus the recorded trace. */
async function start(layer: AgentPluginsLayer): Promise<{
  state: AgentPluginsState;
  ctx: ExecutionContext;
  events: ReturnType<typeof fakeExecutionContext>['events'];
}> {
  const { ctx, events } = fakeExecutionContext();
  const init = layer.hooks.init;
  if (init === undefined) {
    throw new Error('layer has no init hook');
  }
  const result = await init({
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      getMany: async () => new Map(),
    },
    scopeKey: 'thread:test',
    ctx,
  });
  return {
    state: result.state,
    ctx,
    events,
  };
}

async function recall(
  layer: AgentPluginsLayer,
  state: AgentPluginsState,
  budget = 4000,
): Promise<string> {
  const hook = layer.hooks.recall;
  if (hook === undefined) {
    throw new Error('layer has no recall hook');
  }
  const { ctx } = fakeExecutionContext();
  const result = await hook({
    log: {
      items: [],
      append: () => {},
    },
    query: '',
    ctx,
    state,
    budget,
  });
  if (result === null) {
    return '';
  }
  return typeof result === 'string' ? result : result.items.map(() => '').join('');
}

/** A two-plugin fixture: one with skills and bundled resources, one bare. */
async function fixtureLayer(overrides: Parameters<typeof agentPlugins>[0] | null = null): Promise<{
  layer: AgentPluginsLayer;
  root: string;
  dataDir: string;
}> {
  const { root, dataDir } = await makePluginRoot([
    {
      manifest: manifest('reports', {
        version: '1.2.0',
        description: 'Reporting helpers',
      }),
      skills: {
        summarize: skillDoc({
          name: 'summarize',
          description: 'Summarizes reports. Use when the user asks for a summary.',
          body: '# Summarize\n\nStep one. Step two.',
        }),
        chart: skillDoc({
          name: 'chart',
          description: 'Charts data. Use when the user asks for a chart.',
          body: '# Chart\n\nDraw it.',
        }),
      },
      files: {
        'skills/summarize/references/REFERENCE.md': 'Detailed reference material.',
        'skills/summarize/scripts/run.sh': '#!/bin/sh\necho hi\n',
      },
    },
    {
      manifest: manifest('bare'),
    },
  ]);

  const layer = agentPlugins(
    overrides ?? {
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    },
  );
  return {
    layer,
    root,
    dataDir,
  };
}

//#endregion

describe('layer shape', () => {
  test('sits at the procedural slot, in thread scope, anchored', async () => {
    const { layer } = await fixtureLayer();
    expect(layer.id).toBe('agent-plugins');
    expect(layer.slot).toBe(Slot.PROCEDURAL);
    expect(layer.scope).toBe('thread');
    expect(layer.placement).toBe('anchor');
  });

  test('omits callMcpTool when MCP is disabled', async () => {
    const { layer } = await fixtureLayer();
    expect(layer.provides?.callMcpTool).toBeUndefined();
    expect(layer.provides?.loadSkill).toBeDefined();
  });

  test('exposes callMcpTool when MCP is enabled', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
    });
    expect(layer.provides?.callMcpTool).toBeDefined();
  });
});

describe('tier 1 — the skill index', () => {
  test('recall lists plugins and every skill with its description', async () => {
    const { layer } = await fixtureLayer();
    const { state } = await start(layer);
    const text = await recall(layer, state);

    expect(text).toContain('<agent_plugins>');
    expect(text).toContain('reports v1.2.0 — Reporting helpers');
    expect(text).toContain('reports/summarize: Summarizes reports.');
    expect(text).toContain('reports/chart: Charts data.');
    // The body is tier 2 — it must not be here yet.
    expect(text).not.toContain('Step one. Step two.');
  });

  test('recall returns null when no plugin loaded', async () => {
    const { root, dataDir } = await makePluginRoot([]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    });
    const { state } = await start(layer);
    expect(await recall(layer, state)).toBe('');
  });
});

describe('tier 2 — loading a skill', () => {
  test('loadSkill returns the body and records the activation', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);

    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'reports/summarize',
      },
      state,
      ctx,
    );
    const result = outcome.result;
    expect(result).toMatchObject({
      ok: true,
      skill: 'reports/summarize',
      instructions: '# Summarize\n\nStep one. Step two.',
    });
    expect(outcome.state).toEqual({
      activated: [
        'reports/summarize',
      ],
    });
  });

  test('lists bundled resources without SKILL.md', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'summarize',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      resources: [
        'references/REFERENCE.md',
        'scripts/run.sh',
      ],
    });
  });

  test('an activated skill body appears in later recalls', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'reports/summarize',
      },
      state,
      ctx,
    );

    const text = await recall(layer, outcome.state ?? state);
    expect(text).toContain('<active_skills>');
    expect(text).toContain('Step one. Step two.');
    // The other skill stays at tier 1.
    expect(text).not.toContain('Draw it.');
  });

  test('resolves a bare skill name when it is unambiguous', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'chart',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: true,
      skill: 'reports/chart',
    });
  });

  test('reports the candidates rather than guessing when a bare name is ambiguous', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('alpha'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
      },
      {
        manifest: manifest('beta'),
        skills: {
          deploy: skillDoc({
            name: 'deploy',
          }),
        },
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    });
    const { state, ctx } = await start(layer);

    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'deploy',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: false,
    });
    expect(JSON.stringify(outcome.result)).toContain('ambiguous');
    expect(outcome.state).toBeUndefined();
  });

  test('reports an unknown skill', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'loadSkill')(
      {
        skill: 'nope',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: false,
    });
  });

  test('re-activating does not duplicate the entry', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const first = await fn(layer, 'loadSkill')(
      {
        skill: 'reports/summarize',
      },
      state,
      ctx,
    );
    const second = await fn(layer, 'loadSkill')(
      {
        skill: 'reports/summarize',
      },
      first.state ?? state,
      ctx,
    );
    expect(second.state).toEqual({
      activated: [
        'reports/summarize',
      ],
    });
  });
});

describe('tier 3 — reading bundled resources', () => {
  test('reads a file inside the skill directory', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'readSkillResource')(
      {
        skill: 'reports/summarize',
        path: 'references/REFERENCE.md',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: true,
      content: 'Detailed reference material.',
    });
  });

  test('denies a traversal out of the skill directory', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'readSkillResource')(
      {
        skill: 'reports/summarize',
        // A sibling skill's file — inside the plugin, outside this skill.
        path: '../chart/SKILL.md',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: false,
    });
  });

  test('reports a missing file rather than throwing', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'readSkillResource')(
      {
        skill: 'reports/summarize',
        path: 'references/ABSENT.md',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: false,
    });
  });

  test('refuses to read a directory as a file', async () => {
    const { layer } = await fixtureLayer();
    const { state, ctx } = await start(layer);
    const outcome = await fn(layer, 'readSkillResource')(
      {
        skill: 'reports/summarize',
        path: 'references',
      },
      state,
      ctx,
    );
    expect(outcome.result).toMatchObject({
      ok: false,
    });
  });
});

describe('budget degradation', () => {
  /**
   * Bodies sized well apart from the index so the thresholds below are about
   * the shedding order, not about where a hard trim happens to land.
   */
  async function bulkyLayer(): Promise<AgentPluginsLayer> {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('reports'),
        skills: {
          older: skillDoc({
            name: 'older',
            description: 'The older skill.',
            body: `OLDER-MARKER ${'x'.repeat(1200)}`,
          }),
          newer: skillDoc({
            name: 'newer',
            description: 'The newer skill.',
            body: `NEWER-MARKER ${'y'.repeat(1200)}`,
          }),
        },
      },
    ]);
    return agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    });
  }

  /** Activated oldest-first, which is the order `loadSkill` appends in. */
  const withBoth: AgentPluginsState = {
    activated: [
      'reports/older',
      'reports/newer',
    ],
  };

  test('keeps both bodies when the budget allows', async () => {
    const layer = await bulkyLayer();
    await start(layer);
    const text = await recall(layer, withBoth, 4000);
    expect(text).toContain('OLDER-MARKER');
    expect(text).toContain('NEWER-MARKER');
  });

  test('sheds the oldest activated body first', async () => {
    const layer = await bulkyLayer();
    await start(layer);
    // Room for the index (~50 tokens) and one 300-token body, but not two.
    const text = await recall(layer, withBoth, 400);
    expect(text).not.toContain('OLDER-MARKER');
    expect(text).toContain('NEWER-MARKER');
  });

  test('drops every body before touching the index', async () => {
    const layer = await bulkyLayer();
    await start(layer);
    const text = await recall(layer, withBoth, 100);
    expect(text).not.toContain('OLDER-MARKER');
    expect(text).not.toContain('NEWER-MARKER');
    // The index — the thing that lets the model know a skill exists at all —
    // survives intact.
    expect(text).toContain('reports/older: The older skill.');
    expect(text).toContain('reports/newer: The newer skill.');
    expect(text).toContain('</agent_plugins>');
  });

  test('a zero budget fails open rather than deleting the block', async () => {
    const { layer } = await fixtureLayer();
    const { state } = await start(layer);
    const text = await recall(layer, state, 0);
    expect(text).toContain('<agent_plugins>');
  });
});

describe('renderDelta', () => {
  test('publishes only the newly activated skill', async () => {
    const { layer } = await fixtureLayer();
    await start(layer);
    const hook = layer.hooks.renderDelta;
    expect(hook).toBeDefined();
    if (hook === undefined) {
      return;
    }
    const { ctx } = fakeExecutionContext();

    const delta = await hook({
      prev: [],
      next: [],
      prevState: {
        activated: [
          'reports/summarize',
        ],
      },
      state: {
        activated: [
          'reports/summarize',
          'reports/chart',
        ],
      },
      ctx,
      budget: 4000,
    });
    expect(delta).toContain('Draw it.');
    // The already-pinned skill is not resent.
    expect(delta).not.toContain('Step one. Step two.');
  });

  test('falls back to a full republish when nothing was activated', async () => {
    const { layer } = await fixtureLayer();
    await start(layer);
    const hook = layer.hooks.renderDelta;
    if (hook === undefined) {
      return;
    }
    const { ctx } = fakeExecutionContext();
    const delta = await hook({
      prev: [],
      next: [],
      prevState: {
        activated: [
          'reports/summarize',
        ],
      },
      state: {
        activated: [
          'reports/summarize',
        ],
      },
      ctx,
      budget: 4000,
    });
    expect(delta).toBeNull();
  });
});

describe('spawn semantics', () => {
  test('a child inherits the parent activations', async () => {
    const { layer } = await fixtureLayer();
    await start(layer);
    const hook = layer.hooks.onSpawn;
    if (hook === undefined) {
      throw new Error('layer has no onSpawn hook');
    }
    const { ctx } = fakeExecutionContext();
    const result = await hook({
      parentState: {
        activated: [
          'reports/summarize',
        ],
      },
      childCtx: ctx,
    });
    expect(result?.childState).toEqual({
      activated: [
        'reports/summarize',
      ],
    });
  });

  test("a child's own activations do not leak back into the parent", async () => {
    const { layer } = await fixtureLayer();
    await start(layer);
    const hook = layer.hooks.onReturn;
    if (hook === undefined) {
      throw new Error('layer has no onReturn hook');
    }
    const { ctx } = fakeExecutionContext();
    const result = await hook({
      childState: {
        activated: [
          'reports/summarize',
          'reports/chart',
        ],
      },
      childLog: {
        items: [],
        append: () => {},
      },
      parentState: {
        activated: [
          'reports/summarize',
        ],
      },
      result: undefined,
      childCtx: ctx,
    });
    expect(result?.parentState).toEqual({
      activated: [
        'reports/summarize',
      ],
    });
  });
});

describe('provides data', () => {
  test('exposes plugins, skills, and diagnostics', async () => {
    const { layer } = await fixtureLayer();
    const { state } = await start(layer);

    expect(Array.isArray(data(layer, 'plugins', state))).toBe(true);
    expect(layer.readPlugins().map((p) => p.manifest.name)).toEqual([
      'bare',
      'reports',
    ]);
    expect(layer.readDiagnostics()).toHaveLength(0);
    expect(layer.readMcpTools()).toHaveLength(0);
    expect(data(layer, 'activeSkills', state)).toEqual([]);
  });

  test('reports diagnostics on the execution trace', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p', {
          unknownField: true,
        }),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    });
    const { events } = await start(layer);

    const reported = events.filter((e) => e.name === 'agent-plugins.diagnostic');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.attributes?.code).toBe('unknown-manifest-field');
  });
});

describe('mcp declaration without connecting', () => {
  test('connectMcp: false leaves servers unconnected but still discovered', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('p'),
        mcp: mcpConfig({
          api: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    const layer = agentPlugins({
      roots: [
        root,
      ],
      dataDir,
      connectMcp: false,
    });
    const { state } = await start(layer);

    expect(layer.readPlugins()[0]?.mcpServers).toHaveLength(1);
    expect(layer.readMcpTools()).toHaveLength(0);
    const text = await recall(layer, state);
    expect(text).not.toContain('<mcp_servers>');
  });
});
