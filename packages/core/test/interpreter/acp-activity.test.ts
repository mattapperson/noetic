/**
 * An agent's activity in the harness's own vocabulary: a call's presentation,
 * progress and structured content, the agent's plan, its mode and model, and
 * images in its message — on the generic events a `callModel` step's calls
 * use, never the protocol's fields (spec 27 § Output → harness events).
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpSessionNotification,
  AgentScope,
  Context,
  ContextData,
  StepAcpAgent,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import {
  contentText,
  modelOf,
  planOf,
  presentationOf,
  progressOf,
  progressReport,
  toolContentOf,
} from '../../src/interpreter/acp-activity';
import { AcpEventBridge } from '../../src/interpreter/acp-events';

//#region Helpers

interface CapturedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
  scope?: AgentScope;
}

const STEP = {
  id: 'agent',
} satisfies Pick<StepAcpAgent, 'id' | 'emit'>;

function bridgeCtx(): {
  bridge: AcpEventBridge;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  const ctx = frameworkCast<
    Context<ContextData> & {
      _broadcaster: unknown;
    }
  >(harness.createContext());
  ctx._broadcaster = {
    emit(event: CapturedEvent) {
      events.push(event);
    },
  };
  return {
    bridge: new AcpEventBridge(STEP, ctx),
    events,
  };
}

function send(bridge: AcpEventBridge, update: AcpSessionNotification['update']): void {
  bridge.forward({
    sessionId: 's1',
    update,
  });
}

function named(events: CapturedEvent[], name: string): CapturedEvent[] {
  return events.filter((event) => event.source === 'framework' && event.type === `test:${name}`);
}

function only(events: CapturedEvent[], name: string): CapturedEvent {
  const found = named(events, name);
  expect(found).toHaveLength(1);
  const [event] = found;
  assert(event);
  return event;
}

const DIFF = {
  type: 'diff' as const,
  path: '/repo/a.ts',
  oldText: 'old',
  newText: 'new',
};

//#endregion

describe('agent tool calls carry the generic presentation', () => {
  it('starts a call with its title, kind, locations and status', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'pending',
      locations: [
        {
          path: '/repo/a.ts',
          line: 4,
        },
      ],
    });

    expect(only(events, 'tool_call_started').data).toEqual({
      name: 'Edit a.ts',
      callId: 'c1',
      toolId: 'edit',
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'pending',
      locations: [
        {
          path: '/repo/a.ts',
          line: 4,
        },
      ],
    });
  });

  it('reports a running call as tool_progress: status, progress, presentation and content', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Run tests',
      kind: 'execute',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      title: 'Run tests (3/10)',
      _meta: {
        progress: 30,
      },
      content: [
        {
          type: 'terminal',
          terminalId: 't1',
        },
      ],
    });

    expect(only(events, 'tool_progress').data).toEqual({
      name: 'Run tests',
      callId: 'c1',
      toolId: 'execute',
      title: 'Run tests (3/10)',
      status: 'in_progress',
      progress: 0.3,
      content: [
        {
          type: 'terminal',
          terminalId: 't1',
        },
      ],
    });
    expect(named(events, 'tool_call_completed')).toHaveLength(0);
  });

  it('completes a call with everything it produced, as structure, and its raw result', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Edit a.ts',
      kind: 'edit',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      content: [
        DIFF,
      ],
    });
    // The final update leaves its content out: the call keeps what it had.
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: {
        path: '/repo/a.ts',
      },
    });

    expect(only(events, 'tool_call_completed').data).toEqual({
      name: 'Edit a.ts',
      callId: 'c1',
      toolId: 'edit',
      error: false,
      content: [
        {
          type: 'diff',
          path: '/repo/a.ts',
          oldText: 'old',
          newText: 'new',
        },
      ],
      result: {
        path: '/repo/a.ts',
      },
    });
    // The diff once on the running report, and once on the completion.
    expect(named(events, 'tool_progress')).toHaveLength(1);
  });

  it('reports a final update that renames a call before completing it', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Read',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'failed',
      title: 'Read missing.ts',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'no such file',
          },
        },
      ],
    });

    const progress = only(events, 'tool_progress');
    expect(progress.data).toEqual({
      name: 'Read',
      callId: 'c1',
      toolId: 'Read',
      title: 'Read missing.ts',
    });
    expect(only(events, 'tool_call_completed').data).toMatchObject({
      error: true,
      output: 'no such file',
    });
    expect(events.indexOf(progress)).toBeLessThan(
      events.indexOf(only(events, 'tool_call_completed')),
    );
  });

  it('reports content an announcement carries, and a call announced already done', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Write b.ts',
      kind: 'edit',
      content: [
        DIFF,
      ],
    });
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c2',
      title: 'Write c.ts',
      status: 'completed',
      content: [
        DIFF,
      ],
    });

    const progress = only(events, 'tool_progress');
    expect(progress.data).toMatchObject({
      callId: 'c1',
      content: [
        DIFF,
      ],
    });
    expect(progress.data).not.toHaveProperty('title');
    expect(only(events, 'tool_call_completed').data).toMatchObject({
      callId: 'c2',
      content: [
        DIFF,
      ],
    });
  });

  it('reports nothing for an update that changes nothing', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Read',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
    });
    expect(named(events, 'tool_progress')).toHaveLength(0);
  });
});

describe("an agent's plan, mode and model", () => {
  it('replaces the plan on every plan update, as plan_updated', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'plan',
      entries: [
        {
          content: 'Read the spec',
          priority: 'high',
          status: 'in_progress',
          _meta: {
            vendor: 1,
          },
        },
      ],
    });

    expect(only(events, 'plan_updated').data).toEqual({
      stepId: 'agent',
      plan: {
        entries: [
          {
            content: 'Read the spec',
            priority: 'high',
            status: 'in_progress',
          },
        ],
      },
    });
  });

  it('carries the draft plan protocol: an item, markdown or file plan, and its removal', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'plan_update',
      plan: {
        type: 'markdown',
        planId: 'p1',
        content: '# Plan',
      },
    });
    send(bridge, {
      sessionUpdate: 'plan_removed',
      planId: 'p1',
    });

    expect(only(events, 'plan_updated').data.plan).toEqual({
      id: 'p1',
      markdown: '# Plan',
    });
    expect(only(events, 'plan_removed').data).toEqual({
      stepId: 'agent',
      id: 'p1',
    });
  });

  it('reports a mode change and a model change as agent_config_updated', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
    });
    const options = [
      {
        type: 'select' as const,
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'opus',
        options: [],
      },
    ];
    send(bridge, {
      sessionUpdate: 'config_option_update',
      configOptions: options,
    });
    // The same model again is no change.
    send(bridge, {
      sessionUpdate: 'config_option_update',
      configOptions: options,
    });

    expect(named(events, 'agent_config_updated').map((event) => event.data)).toEqual([
      {
        stepId: 'agent',
        mode: 'plan',
      },
      {
        stepId: 'agent',
        model: 'opus',
      },
    ]);
  });
});

describe("an image in the agent's message", () => {
  it('is an image output item, as a model generated it, never text', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Here:',
      },
    });
    send(bridge, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'image',
        mimeType: 'image/png',
        data: 'AAAA',
      },
    });

    const deltas = events.filter((event) => event.type === 'response.output_text.delta');
    expect(deltas.map((event) => event.data.delta)).toEqual([
      'Here:',
    ]);
    const done = events.filter((event) => event.type === 'response.output_item.done');
    expect(done.map((event) => event.data.item)).toEqual([
      expect.objectContaining({
        type: 'message',
      }),
      expect.objectContaining({
        type: 'image_generation_call',
        status: 'completed',
        result: 'data:image/png;base64,AAAA',
      }),
    ]);
  });
});

describe('acp-activity helpers', () => {
  it('maps every content kind', () => {
    expect(
      toolContentOf([
        DIFF,
        {
          type: 'diff',
          path: '/n.ts',
          newText: 'x',
        },
        {
          type: 'content',
          content: {
            type: 'image',
            mimeType: 'image/png',
            data: 'AA',
            uri: 'file:///i.png',
          },
        },
        {
          type: 'content',
          content: {
            type: 'audio',
            mimeType: 'audio/wav',
            data: 'BB',
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'file:///r',
            name: 'r',
            title: 'R',
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///t',
              text: 'body',
              mimeType: 'text/plain',
            },
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///b',
              blob: 'CC',
            },
          },
        },
      ]),
    ).toEqual([
      DIFF,
      {
        type: 'diff',
        path: '/n.ts',
        oldText: null,
        newText: 'x',
      },
      {
        type: 'input_image',
        imageUrl: 'data:image/png;base64,AA',
      },
      {
        type: 'input_file',
        fileData: 'data:audio/wav;base64,BB',
      },
      {
        type: 'resource_link',
        uri: 'file:///r',
        name: 'r',
        title: 'R',
      },
      {
        type: 'resource',
        uri: 'file:///t',
        mimeType: 'text/plain',
        text: 'body',
      },
      {
        type: 'resource',
        uri: 'file:///b',
        blob: 'CC',
      },
    ]);
    expect(toolContentOf(null)).toEqual([]);
  });

  it('joins only text content into the output text', () => {
    expect(
      contentText([
        {
          type: 'input_text',
          text: 'a',
        },
        DIFF,
        {
          type: 'input_text',
          text: 'b',
        },
      ]),
    ).toBe('a\nb');
    expect(
      contentText([
        DIFF,
      ]),
    ).toBeUndefined();
  });

  it('reads progress from _meta, else the raw output, as a fraction', () => {
    const base = {
      sessionUpdate: 'tool_call_update' as const,
      toolCallId: 'c',
    };
    expect(
      progressOf({
        ...base,
        _meta: {
          progress: 0.5,
        },
      }),
    ).toBe(0.5);
    expect(
      progressOf({
        ...base,
        rawOutput: {
          progress: 100,
        },
      }),
    ).toBe(1);
    expect(
      progressOf({
        ...base,
        rawOutput: {
          progress: 'half',
        },
      }),
    ).toBeUndefined();
    expect(progressOf(base)).toBeUndefined();
  });

  it('presents only what the update says', () => {
    expect(
      presentationOf({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c',
        locations: [],
      }),
    ).toEqual({});
    expect(
      progressReport(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c',
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('reads a file plan and an item plan from the draft protocol', () => {
    expect(
      planOf({
        sessionUpdate: 'plan_update',
        plan: {
          type: 'file',
          planId: 'p',
          uri: 'file:///plan.md',
        },
      }),
    ).toEqual({
      id: 'p',
      uri: 'file:///plan.md',
    });
    expect(
      planOf({
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'p',
          entries: [
            {
              content: 'x',
              priority: 'low',
              status: 'completed',
            },
          ],
        },
      }),
    ).toEqual({
      id: 'p',
      entries: [
        {
          content: 'x',
          priority: 'low',
          status: 'completed',
        },
      ],
    });
  });

  it('finds the model option by category, else by id', () => {
    const select = (id: string, value: string, category?: string) => ({
      type: 'select' as const,
      id,
      name: id,
      currentValue: value,
      options: [],
      ...(category
        ? {
            category,
          }
        : {}),
    });
    expect(
      modelOf([
        select('model', 'by-id'),
        select('m', 'by-category', 'model'),
      ]),
    ).toBe('by-category');
    expect(
      modelOf([
        select('model', 'by-id'),
      ]),
    ).toBe('by-id');
    expect(modelOf(undefined)).toBeUndefined();
  });
});

describe('a call to one of the step tools', () => {
  it('presents as its tool declares, never by the name the agent announced it under', () => {
    const { bridge, events } = bridgeCtx();
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'mcp__noetic__echo',
      kind: 'other',
    });
    bridge.bridgedCallStarted('c1', 'echo', {}, {});
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c2',
      title: 'mcp__noetic__echo',
      kind: 'other',
    });
    bridge.finalize({
      stopReason: 'end_turn',
      text: '',
      items: [],
    });

    const started = named(events, 'tool_call_started').map((event) => event.data);
    expect(started[0]).toEqual({
      name: 'echo',
      callId: 'c1',
      toolId: 'echo',
    });
    // One that never reached the tool is the agent's call, as it announced it.
    expect(started[1]).toEqual({
      name: 'echo',
      callId: 'c2',
      toolId: 'echo',
      title: 'mcp__noetic__echo',
      kind: 'other',
    });
  });
});

describe("an agent's own call is identified by the tool it is to", () => {
  it('names the tool as the adapter reads it, on every event of the call', () => {
    const { bridge, events } = bridgeCtx();
    bridge.identifyToolCalls((update) =>
      update.toolCallId === 'mcp'
        ? {
            id: 'read_file',
            server: 'workspace',
          }
        : undefined,
    );
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp',
      title: 'Read file',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mcp',
      status: 'in_progress',
    });
    send(bridge, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mcp',
      status: 'completed',
    });
    // One the adapter cannot place goes by its title.
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'other',
      title: 'Think',
    });

    for (const name of [
      'tool_call_started',
      'tool_progress',
      'tool_call_completed',
    ]) {
      expect(named(events, name)[0]?.data).toMatchObject({
        callId: 'mcp',
        toolId: 'read_file',
        toolServer: 'workspace',
      });
    }
    expect(named(events, 'tool_call_started')[1]?.data).toMatchObject({
      toolId: 'Think',
    });
    expect(named(events, 'tool_call_started')[1]?.data).not.toHaveProperty('toolServer');
  });

  it('goes by its title when the adapter throws', () => {
    const { bridge, events } = bridgeCtx();
    bridge.identifyToolCalls(() => {
      throw new Error('unreadable');
    });
    bridge.identifyToolCalls(undefined);
    bridge.begin();
    send(bridge, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Bash',
    });
    expect(only(events, 'tool_call_started').data.toolId).toBe('Bash');
  });
});

describe('a call no reader can place', () => {
  it('goes by its kind, so calls named by title alone group as one tool, else by its title', () => {
    const { bridge, events } = bridgeCtx();
    bridge.begin();
    for (const [callId, title, kind] of [
      [
        'c1',
        'Run ls',
        'execute',
      ],
      [
        'c2',
        'Run pwd',
        'execute',
      ],
      [
        'c3',
        'Something',
        'other',
      ],
    ] as const) {
      send(bridge, {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title,
        kind,
      });
    }
    expect(named(events, 'tool_call_started').map((event) => event.data.toolId)).toEqual([
      'execute',
      'execute',
      'Something',
    ]);
  });
});
