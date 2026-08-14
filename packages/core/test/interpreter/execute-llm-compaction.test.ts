/**
 * Compaction reaching the model, through the interpreter.
 *
 * The unit suite (test/context/compaction.test.ts) proves `foldCompactions` is
 * correct in isolation. This proves the interpreter actually applies it: a
 * compaction record written to the item log must shrink what `callModel`
 * receives, and crossing `compactAt` must surface as a `context_pressure`
 * framework event rather than a silent trim.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { compactionAsItem, createCompaction } from '@noetic-tools/context';
import type {
  CallModelRequest,
  Item,
  ProjectionPolicy,
  StepCallModel,
  StreamEvent,
} from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import { executeCallModel } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { makeLLMResponse, makeMockHarness } from '../_helpers';

//#region Helpers

/** A real broadcaster that also records what it was asked to emit. */
class RecordingBroadcaster extends EventBroadcaster {
  readonly events: StreamEvent[] = [];

  override emit(event: StreamEvent): void {
    this.events.push(event);
    super.emit(event);
  }
}

/** One inert layer — enough to put executeCallModel on the layer-bearing assembly path. */
const LAYERS: ContextLayer[] = [
  {
    id: 'inert',
    slot: 275,
    scope: 'execution',
    hooks: {},
  },
];

const STEP: StepCallModel<ContextData, string, string> = {
  kind: 'callModel',
  id: 'compaction-step',
  model: 'gpt-4',
};

interface Rig {
  ctx: ContextImpl;
  events: StreamEvent[];
  request: () => CallModelRequest;
}

/** An executeCallModel rig with a recording broadcaster and a captured model request. */
function makeRig(): Rig {
  let captured: CallModelRequest | undefined;
  const harness = makeMockHarness();
  harness.callModel = async (request) => {
    captured = request;
    return makeLLMResponse('done');
  };
  const broadcaster = new RecordingBroadcaster();
  const ctx = new ContextImpl({
    harness,
    _broadcaster: broadcaster,
  });
  return {
    ctx,
    events: broadcaster.events,
    request: () => {
      assert(captured !== undefined, 'callModel was never invoked');
      return captured;
    },
  };
}

/** Append one system message to the log — the band the budget never trims. */
function seedSystem(ctx: ContextImpl, text: string): void {
  ctx.itemLog.append(
    frameworkCast<Item>({
      id: `sys-${text}`,
      type: 'message',
      role: 'system',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    }),
  );
}

/** Every text part of every message item in a request, in order. */
function requestTexts(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    item.type === 'message'
      ? item.content.flatMap((part) =>
          'text' in part
            ? [
                part.text,
              ]
            : [],
        )
      : [],
  );
}

/** Seed `count` user turns of roughly `pad` characters each. */
function seedTurns(ctx: ContextImpl, count: number, pad = 0): void {
  for (let i = 0; i < count; i++) {
    ctx.itemLog.append(
      frameworkCast<Item>({
        id: `u-${i}`,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: `q-${i} ${'x'.repeat(pad)}`,
          },
        ],
      }),
    );
  }
}

/** Framework events of one type, unwrapped to their data payloads. */
function frameworkData(events: StreamEvent[], type: string): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.source !== 'framework' || !event.type.endsWith(`:${type}`)) {
      continue;
    }
    assert(typeof event.data === 'object' && event.data !== null);
    matches.push(frameworkCast<Record<string, unknown>>(event.data));
  }
  return matches;
}

//#endregion

describe('executeCallModel — compaction folded into the request', () => {
  it('a compaction record in the log shrinks what the model receives', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 10);
    const beforeCount = rig.ctx.itemLog.items.length;

    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 8,
      summary: 'the first eight turns, summarized',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeCallModel(STEP, '', rig.ctx, LAYERS);

    const sent = rig.request().items;
    // The log GREW (compaction is append-only) but the view SHRANK.
    expect(rig.ctx.itemLog.items.length).toBeGreaterThan(beforeCount);
    expect(sent.length).toBeLessThan(beforeCount);
    // The summary reached the model in place of the covered prefix...
    const texts = requestTexts(sent);
    expect(texts.some((t) => t.includes('the first eight turns, summarized'))).toBe(true);
    expect(texts.some((t) => t.includes('q-0'))).toBe(false);
    // ...and the uncompacted tail survived.
    expect(texts.some((t) => t.includes('q-9'))).toBe(true);
    // The raw record itself never goes to the provider.
    expect(sent.some((i) => i.type === compaction.type)).toBe(false);
  });

  it('folds on the no-layers path too', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 6);
    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 5,
      summary: 'earlier turns',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeCallModel(STEP, '', rig.ctx);

    const sent = rig.request().items;
    expect(sent.some((i) => i.type === compaction.type)).toBe(false);
    const texts = requestTexts(sent);
    expect(texts.some((t) => t.includes('earlier turns'))).toBe(true);
    expect(texts.some((t) => t.includes('q-0'))).toBe(false);
  });

  it('leaves an uncompacted log untouched', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 4);

    await executeCallModel(STEP, '', rig.ctx, LAYERS);

    const texts = requestTexts(rig.request().items);
    for (let i = 0; i < 4; i++) {
      expect(texts.some((t) => t.includes(`q-${i}`))).toBe(true);
    }
  });
});

describe('executeCallModel — the fold index survives the system/tail partition', () => {
  /**
   * `replacesUntil` indexes the RAW log. The layered path splits system and
   * steering-tail items out of that log before assembling, so folding the
   * shortened array applies the index to the wrong list — the cut lands one
   * position further along per stripped item and eats live turns past the
   * compaction boundary, silently.
   */
  it('keeps every turn past replacesUntil when a system message precedes them', async () => {
    const rig = makeRig();
    // Raw log: [SYSTEM, q-0..q-5, compaction(replacesUntil: 5)].
    seedSystem(rig.ctx, 'you are a helpful assistant');
    seedTurns(rig.ctx, 6);
    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 5,
      summary: 'the earliest turns, summarized',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeCallModel(STEP, '', rig.ctx, LAYERS);

    const texts = requestTexts(rig.request().items);
    // replacesUntil 5 covers raw[0..4] = SYSTEM + q-0..q-3, so q-4 and q-5 live.
    expect(texts.some((t) => t.includes('the earliest turns, summarized'))).toBe(true);
    expect(texts.some((t) => t.includes('q-4'))).toBe(true);
    expect(texts.some((t) => t.includes('q-5'))).toBe(true);
    // The system prompt is never dropped, even though the fold covered it.
    expect(texts.some((t) => t.includes('you are a helpful assistant'))).toBe(true);
    // ...and the covered prefix really is gone.
    expect(texts.some((t) => t.includes('q-0'))).toBe(false);
  });

  it('agrees with the bare no-layer path on the same log', async () => {
    const seed = (rig: Rig): void => {
      seedSystem(rig.ctx, 'system prompt');
      seedTurns(rig.ctx, 6);
      rig.ctx.itemLog.append(
        compactionAsItem(
          createCompaction({
            items: rig.ctx.itemLog.items,
            replacesUntil: 5,
            summary: 'summary',
          }),
        ),
      );
    };

    const layered = makeRig();
    seed(layered);
    await executeCallModel(STEP, '', layered.ctx, LAYERS);

    const bare = makeRig();
    seed(bare);
    await executeCallModel(STEP, '', bare.ctx);

    // The same log must not yield a different history just because layers exist.
    const layeredTexts = requestTexts(layered.request().items).filter((t) => t.startsWith('q-'));
    const bareTexts = requestTexts(bare.request().items).filter((t) => t.startsWith('q-'));
    expect(layeredTexts).toEqual(bareTexts);
  });

  it('holds with several system items ahead of the boundary', async () => {
    const rig = makeRig();
    // Raw log: [SYS-a, SYS-b, SYS-c, q-0..q-5, compaction(replacesUntil: 6)].
    seedSystem(rig.ctx, 'rule-a');
    seedSystem(rig.ctx, 'rule-b');
    seedSystem(rig.ctx, 'rule-c');
    seedTurns(rig.ctx, 6);
    rig.ctx.itemLog.append(
      compactionAsItem(
        createCompaction({
          items: rig.ctx.itemLog.items,
          replacesUntil: 6,
          summary: 'covered',
        }),
      ),
    );

    await executeCallModel(STEP, '', rig.ctx, LAYERS);

    const texts = requestTexts(rig.request().items);
    // replacesUntil 6 covers raw[0..5] = 3 system items + q-0..q-2; q-3..q-5 live.
    // Three stripped system items = three turns lost to the old index drift.
    for (const live of [
      'q-3',
      'q-4',
      'q-5',
    ]) {
      expect(texts.some((t) => t.includes(live))).toBe(true);
    }
    for (const rule of [
      'rule-a',
      'rule-b',
      'rule-c',
    ]) {
      expect(texts.some((t) => t.includes(rule))).toBe(true);
    }
    expect(texts.some((t) => t.includes('q-2'))).toBe(false);
  });

  it('resolves stacked compactions against the raw index space', async () => {
    const rig = makeRig();
    seedSystem(rig.ctx, 'system prompt');
    seedTurns(rig.ctx, 8);
    // An early compaction, then a later one that subsumes it.
    rig.ctx.itemLog.append(
      compactionAsItem(
        createCompaction({
          items: rig.ctx.itemLog.items,
          replacesUntil: 3,
          summary: 'first summary',
        }),
      ),
    );
    rig.ctx.itemLog.append(
      compactionAsItem(
        createCompaction({
          items: rig.ctx.itemLog.items,
          replacesUntil: 7,
          summary: 'second summary',
        }),
      ),
    );

    await executeCallModel(STEP, '', rig.ctx, LAYERS);

    const texts = requestTexts(rig.request().items);
    // The higher replacesUntil (7) wins: raw[0..6] = SYSTEM + q-0..q-5 covered,
    // so q-6 and q-7 must survive.
    expect(texts.some((t) => t.includes('second summary'))).toBe(true);
    expect(texts.some((t) => t.includes('first summary'))).toBe(false);
    expect(texts.some((t) => t.includes('q-6'))).toBe(true);
    expect(texts.some((t) => t.includes('q-7'))).toBe(true);
    expect(texts.some((t) => t.includes('q-5'))).toBe(false);
  });

  it('a steering retry replays the same history rather than a shorter one', async () => {
    // Each Guide retry appends a guidance item and adds its id to tailIds, so a
    // partition-then-fold order drops one more turn on every pass.
    let calls = 0;
    const views: string[][] = [];
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      calls++;
      views.push(requestTexts(request.items).filter((t) => t.startsWith('q-')));
      return makeLLMResponse('done');
    };
    harness.afterModelCall = async () =>
      calls === 1
        ? {
            action: SteeringAction.Guide,
            guidance: 'try again',
          }
        : {
            action: SteeringAction.Allow,
          };
    const ctx = new ContextImpl({
      harness,
      _broadcaster: new RecordingBroadcaster(),
    });
    seedSystem(ctx, 'system prompt');
    seedTurns(ctx, 6);
    ctx.itemLog.append(
      compactionAsItem(
        createCompaction({
          items: ctx.itemLog.items,
          replacesUntil: 5,
          summary: 'summary',
        }),
      ),
    );

    await executeCallModel(STEP, '', ctx, LAYERS);

    expect(calls).toBe(2);
    // The retry is a replay of the same history, not a shortened view of it.
    expect(views[1]).toEqual(views[0]);
    expect(views[1].some((t) => t.startsWith('q-5'))).toBe(true);
  });
});

describe('executeCallModel — context_pressure event', () => {
  // A budget tight enough that 40 padded turns cross the default 80% compactAt.
  const tightPolicy: ProjectionPolicy = {
    tokenBudget: 2_000,
    responseReserve: 200,
    overflow: 'sliding_window',
  };
  const tightStep: StepCallModel<ContextData, string, string> = {
    ...STEP,
    projection: tightPolicy,
  };

  it('emits context_pressure when folded history crosses compactAt', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);

    await executeCallModel(tightStep, '', rig.ctx, LAYERS);

    const emitted = frameworkData(rig.events, 'context_pressure');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].nodeId).toBe(tightStep.id);
    const historyTokens = emitted[0].historyTokens;
    const compactAt = emitted[0].compactAt;
    assert(typeof historyTokens === 'number' && typeof compactAt === 'number');
    expect(historyTokens).toBeGreaterThan(compactAt);
  });

  it('stays silent under the threshold', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 2);

    await executeCallModel(tightStep, '', rig.ctx, LAYERS);

    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('a compaction that relieves the pressure silences the event', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);
    const compaction = createCompaction({
      items: rig.ctx.itemLog.items,
      replacesUntil: 39,
      summary: 'everything before the last turn',
    });
    rig.ctx.itemLog.append(compactionAsItem(compaction));

    await executeCallModel(tightStep, '', rig.ctx, LAYERS);

    // Measured POST-fold, so relieving the pressure genuinely turns the signal
    // off — otherwise an agent that compacted would keep being told to compact.
    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('still fires when the threshold is crossed on a steering retry', async () => {
    // The once-per-step latch must close on an actual EMISSION, not on the first
    // evaluation. A first assembly with room to spare that latched the flag would
    // leave a retry which crosses compactAt to trim the oldest turns in silence.
    let calls = 0;
    const broadcaster = new RecordingBroadcaster();
    const harness = makeMockHarness();
    const ctx = new ContextImpl({
      harness,
      _broadcaster: broadcaster,
    });
    harness.callModel = async () => {
      calls++;
      return makeLLMResponse('done');
    };
    harness.afterModelCall = async () => {
      if (calls > 1) {
        return {
          action: SteeringAction.Allow,
        };
      }
      // Between the two assemblies, grow the log past compactAt.
      seedTurns(ctx, 40, 120);
      return {
        action: SteeringAction.Guide,
        guidance: 'try again',
      };
    };
    // First assembly: two short turns, comfortably under the threshold.
    seedTurns(ctx, 2);

    await executeCallModel(tightStep, '', ctx, LAYERS);

    expect(calls).toBe(2);
    const emitted = frameworkData(broadcaster.events, 'context_pressure');
    expect(emitted).toHaveLength(1);
    const historyTokens = emitted[0].historyTokens;
    const compactAt = emitted[0].compactAt;
    assert(typeof historyTokens === 'number' && typeof compactAt === 'number');
    expect(historyTokens).toBeGreaterThan(compactAt);
  });

  it('honours step.emit === false', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);

    await executeCallModel(
      {
        ...tightStep,
        emit: false,
      },
      '',
      rig.ctx,
      LAYERS,
    );

    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });

  it('honours an emit predicate that filters the event out', async () => {
    const rig = makeRig();
    seedTurns(rig.ctx, 40, 120);
    const asked: string[] = [];

    await executeCallModel(
      {
        ...tightStep,
        emit: (eventType) => {
          asked.push(eventType);
          return eventType !== 'context_pressure';
        },
      },
      '',
      rig.ctx,
      LAYERS,
    );

    expect(asked).toContain('context_pressure');
    expect(frameworkData(rig.events, 'context_pressure')).toHaveLength(0);
  });
});
