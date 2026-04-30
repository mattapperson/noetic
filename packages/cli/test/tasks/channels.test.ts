import { describe, expect, test } from 'bun:test';

import {
  externalTaskEventsChan,
  FeatureLoopStateChangedMessageSchema,
  featureLoopStateChan,
  ValidatorOutcomeSchema,
  ValidatorOutcomeStatus,
  ValidatorRequestSchema,
  validatorOutcomeChan,
  validatorRequestChan,
} from '../../src/commands/builtins/tasks/channels.js';
import { FeatureLoopState } from '../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { EventKind, EventSchema } from '../../src/commands/builtins/tasks/schemas.js';

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

//#region validatorOutcomeChan

describe('validatorOutcomeChan', () => {
  test('declares the canonical name, queue mode, and capacity 1024', () => {
    expect(validatorOutcomeChan.name).toBe('tasks.validator-outcome');
    expect(validatorOutcomeChan.mode).toBe('queue');
    expect(validatorOutcomeChan.capacity).toBe(1024);
  });

  test('schema accepts pass/fail/blocked statuses', () => {
    for (const status of [
      ValidatorOutcomeStatus.Pass,
      ValidatorOutcomeStatus.Fail,
      ValidatorOutcomeStatus.Blocked,
    ]) {
      const parsed = ValidatorOutcomeSchema.safeParse({
        taskId: 'T-aaaaaaaaaa',
        featureId: 'F-bbbbbbbbbb',
        runId: 'V-cccccccccc',
        status,
        result: null,
      });
      expect(parsed.success).toBe(true);
    }
  });

  test('schema rejects unknown statuses', () => {
    const bad = ValidatorOutcomeSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
      runId: 'V-cccccccccc',
      status: 'pending',
      result: null,
    });
    expect(bad.success).toBe(false);
  });

  test('schema accepts a structured result payload', () => {
    const parsed = ValidatorOutcomeSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
      runId: 'V-cccccccccc',
      status: ValidatorOutcomeStatus.Pass,
      result: {
        summary: 'all good',
        passes: 12,
      },
    });
    expect(parsed.success).toBe(true);
  });

  test('schema rejects a missing result field (must be explicit null)', () => {
    const bad = ValidatorOutcomeSchema.safeParse({
      taskId: 'T-aaaaaaaaaa',
      featureId: 'F-bbbbbbbbbb',
      runId: 'V-cccccccccc',
      status: ValidatorOutcomeStatus.Pass,
    });
    expect(bad.success).toBe(false);
  });

  test('is internal (no external marker)', () => {
    expect('external' in validatorOutcomeChan).toBe(false);
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
  test('exports four distinct channels under unique names', () => {
    const names = new Set([
      validatorRequestChan.name,
      validatorOutcomeChan.name,
      featureLoopStateChan.name,
      externalTaskEventsChan.name,
    ]);
    expect(names.size).toBe(4);
  });
});

//#endregion
