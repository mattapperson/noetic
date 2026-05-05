import { describe, expect, test } from 'bun:test';

import {
  externalTaskEventsChan,
  FeatureLoopStateChangedMessageSchema,
  featureLoopStateChan,
  ValidatorRequestSchema,
  validatorRequestChan,
} from '@noetic/code-agent/tasks/ipc-node';
import { FeatureLoopState } from '../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { EventKind, EventSchema } from '@noetic/code-agent/tasks/schema';

//#region validatorRequestChan

describe('validatorRequestChan', () => {
  test('declares the canonical name, queue mode, and capacity 1024', () => {
    expect(validatorRequestChan.name).toBe('tasks.validator-request');
    expect(validatorRequestChan.mode).toBe('queue');
    expect(validatorRequestChan.capacity).toBe(1024);
  });

  test('schema accepts taskId + featureId pairs', () => {
    const ok = ValidatorRequestSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
    });
    expect(ok.success).toBe(true);
  });

  test('schema rejects missing fields', () => {
    const bad = ValidatorRequestSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
    });
    expect(bad.success).toBe(false);
  });

  test('schema rejects non-string identifiers', () => {
    const bad = ValidatorRequestSchema.safeParse({
      taskId: 1,
      featureId: 2,
    });
    expect(bad.success).toBe(false);
  });

  test('is internal (no external marker)', () => {
    expect('external' in validatorRequestChan).toBe(false);
  });
});

//#endregion

//#region featureLoopStateChan

describe('featureLoopStateChan', () => {
  test('declares the canonical name and topic mode (no capacity)', () => {
    expect(featureLoopStateChan.name).toBe('tasks.feature-loop-state');
    expect(featureLoopStateChan.mode).toBe('topic');
    expect(featureLoopStateChan.capacity).toBeUndefined();
  });

  test('schema accepts every FeatureLoopState pair', () => {
    const parsed = FeatureLoopStateChangedMessageSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
      previousLoopState: FeatureLoopState.Implementing,
      loopState: FeatureLoopState.Validating,
    });
    expect(parsed.success).toBe(true);
  });

  test('schema rejects unknown loop states', () => {
    const bad = FeatureLoopStateChangedMessageSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
      previousLoopState: 'unknown',
      loopState: FeatureLoopState.Validating,
    });
    expect(bad.success).toBe(false);
  });

  test('is internal (no external marker)', () => {
    expect('external' in featureLoopStateChan).toBe(false);
  });
});

//#endregion

//#region externalTaskEventsChan

describe('externalTaskEventsChan', () => {
  test('declares the canonical name, queue mode, and capacity 4096', () => {
    expect(externalTaskEventsChan.name).toBe('tasks.events');
    expect(externalTaskEventsChan.mode).toBe('queue');
    expect(externalTaskEventsChan.capacity).toBe(4096);
  });

  test('is marked external for cross-process producers', () => {
    expect(externalTaskEventsChan.external).toBe(true);
  });

  test('schema is the on-disk EventSchema (round-trips a real event)', () => {
    const event = {
      id: 1,
      taskId: 'T-aaaaaaaaaa',
      kind: EventKind.TaskCreated,
      payload: {
        title: 'hello',
      },
      ts: '2026-04-30T00:00:00.000Z',
    };
    expect(externalTaskEventsChan.schema).toBe(EventSchema);
    const parsed = externalTaskEventsChan.schema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  test('schema rejects events missing the monotonic id', () => {
    const bad = externalTaskEventsChan.schema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      kind: EventKind.TaskCreated,
      ts: '2026-04-30T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });
});

//#endregion

//#region Surface

describe('channels module surface', () => {
  test('exports three distinct channels under unique names', () => {
    const names = new Set([
      validatorRequestChan.name,
      featureLoopStateChan.name,
      externalTaskEventsChan.name,
    ]);
    expect(names.size).toBe(3);
  });
});

//#endregion
