import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  Item,
  StreamEvent,
  SubHarness,
  SubHarnessKind,
  SubHarnessSession,
  SubHarnessStreamPart,
} from '@noetic-tools/types';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { buildItemStream, filterTextStream } from '../../src/runtime/session-streams';
import { makeFunctionCall, makeMessage } from '../_helpers';

//#region Adapters

type TurnImpl = (emit: (part: SubHarnessStreamPart) => void) => {
  items: Item[];
  text: string;
};

function adapter(harnessId: SubHarnessKind, turn: TurnImpl): SubHarness {
  return {
    specificationVersion: 'harness-v1',
    harnessId,
    async doStart(): Promise<SubHarnessSession> {
      return {
        sessionId: 's',
        isResume: false,
        async doPromptTurn(opts) {
          const result = turn(opts.emit);
          return {
            items: result.items,
            text: result.text,
          };
        },
        async doStop() {
          return {
            harnessId,
            sessionId: 's',
            state: null,
          };
        },
      };
    },
  };
}

async function collect(broadcaster: EventBroadcaster): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of broadcaster) {
    events.push(e);
  }
  return events;
}

async function collectText(broadcaster: EventBroadcaster): Promise<string> {
  let text = '';
  for await (const chunk of filterTextStream(broadcaster)) {
    text += chunk;
  }
  return text;
}

//#endregion

describe('sub-harness output → harness events', () => {
  it('maps streamed parts onto the sdk event surface (text + items)', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    const broadcaster = new EventBroadcaster();
    const ctx = harness.createContext({
      _broadcaster: broadcaster,
    });

    const streaming = adapter('claude-code', (emit) => {
      emit({
        type: 'stream-start',
      });
      emit({
        type: 'reasoning-delta',
        delta: 'thinking…',
      });
      emit({
        type: 'text-delta',
        delta: 'Hello ',
      });
      emit({
        type: 'text-delta',
        delta: 'world',
      });
      emit({
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'Bash',
        input: {
          cmd: 'ls',
        },
      });
      emit({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          input: 1,
          output: 1,
        },
      });
      return {
        items: [
          makeMessage('assistant', 'Hello world'),
        ],
        text: 'Hello world',
      };
    });
    const harnessStep = step.claudeCode({
      id: 'stream',
      harness: streaming,
      prompt: 'go',
    });

    await execute(harnessStep, undefined, ctx);
    broadcaster.complete();

    const events = await collect(broadcaster);
    const sdkTypes = events.filter((e) => e.source === 'sdk').map((e) => e.type);
    expect(sdkTypes).toContain('response.created');
    expect(sdkTypes).toContain('response.output_item.added');
    expect(sdkTypes).toContain('response.output_text.delta');
    expect(sdkTypes).toContain('response.reasoning.delta');
    expect(sdkTypes).toContain('response.function_call_arguments.delta');
    expect(sdkTypes).toContain('response.completed');

    // The raw structured part is also available as a framework event.
    const frameworkTypes = events.filter((e) => e.source === 'framework').map((e) => e.type);
    expect(frameworkTypes.some((t) => t.endsWith(':sub_harness_event'))).toBe(true);

    // getTextStream surfaces the agent's text.
    expect(await collectText(broadcaster)).toBe('Hello world');

    // getItemStream surfaces a completed assistant message + a function-call item.
    const items: Item[] = [];
    for await (const snapshot of buildItemStream(broadcaster)) {
      items.push(snapshot);
    }
    const finalMessage = items.findLast((i) => i.type === 'message');
    assert(finalMessage && finalMessage.type === 'message');
    const text = finalMessage.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toBe('Hello world');
    expect(items.some((i) => i.type === 'function_call')).toBe(true);
  });

  it('always emits output: a non-streaming adapter still surfaces text + tool calls', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    const broadcaster = new EventBroadcaster();
    const ctx = harness.createContext({
      _broadcaster: broadcaster,
    });

    // doPromptTurn returns a result WITHOUT calling emit — finalize() synthesizes events.
    const silent = adapter('codex', () => ({
      items: [
        makeMessage('assistant', 'final answer'),
        makeFunctionCall('Bash', '{"cmd":"ls"}', 'fc1'),
      ],
      text: 'final answer',
    }));
    const harnessStep = step.codex({
      id: 'silent',
      harness: silent,
      prompt: 'go',
    });

    await execute(harnessStep, undefined, ctx);
    broadcaster.complete();

    const events = await collect(broadcaster);
    const sdkTypes = events.filter((e) => e.source === 'sdk').map((e) => e.type);
    expect(sdkTypes).toContain('response.output_text.delta');
    expect(sdkTypes).toContain('response.function_call_arguments.delta');
    expect(await collectText(broadcaster)).toBe('final answer');
  });

  it('emit:false suppresses all events', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    const broadcaster = new EventBroadcaster();
    const ctx = harness.createContext({
      _broadcaster: broadcaster,
    });

    const streaming = adapter('opencode', (emit) => {
      emit({
        type: 'text-delta',
        delta: 'hidden',
      });
      emit({
        type: 'finish',
        finishReason: 'stop',
      });
      return {
        items: [
          makeMessage('assistant', 'hidden'),
        ],
        text: 'hidden',
      };
    });
    const harnessStep = step.opencode({
      id: 'quiet',
      harness: streaming,
      prompt: 'go',
      emit: false,
    });

    await execute(harnessStep, undefined, ctx);
    broadcaster.complete();

    const events = await collect(broadcaster);
    expect(events.length).toBe(0);
  });

  it('always emits a lifecycle: a silent adapter still brackets the turn', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    const broadcaster = new EventBroadcaster();
    const ctx = harness.createContext({
      _broadcaster: broadcaster,
    });

    // Streams nothing and returns an empty result.
    const silent = adapter('pi', () => ({
      items: [],
      text: '',
    }));
    const harnessStep = step.pi({
      id: 'noop',
      harness: silent,
      prompt: 'go',
    });

    await execute(harnessStep, undefined, ctx);
    broadcaster.complete();

    const sdkTypes = (await collect(broadcaster))
      .filter((e) => e.source === 'sdk')
      .map((e) => e.type);
    expect(sdkTypes).toContain('response.created');
    expect(sdkTypes).toContain('response.completed');
  });
});
