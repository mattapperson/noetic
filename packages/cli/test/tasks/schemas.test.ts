import { describe, expect, it } from 'bun:test';

import {
  AutopilotState,
  EventKind,
  EventSchema,
  generateId,
  generateTaskId,
  HierarchyStatus,
  ID_LENGTH,
  IdPrefix,
  isValidId,
  LogEntryKind,
  LogEntrySchema,
  StateSchema,
  TaskIdSchema,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSchema,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';

//#region ID helpers

describe('generateTaskId / generateId / isValidId', () => {
  it('produces unique task IDs of the form T-<10 chars>', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(TaskIdSchema.safeParse(id).success).toBe(true);
      expect(id.startsWith('T-')).toBe(true);
      expect(id.length).toBe(2 + ID_LENGTH);
      expect(isValidId(id)).toBe(true);
    }
  });

  it('produces unique IDs for each prefix', () => {
    const ml = generateId(IdPrefix.Milestone);
    const sl = generateId(IdPrefix.Slice);
    const f = generateId(IdPrefix.Feature);
    expect(ml.startsWith('ML-')).toBe(true);
    expect(sl.startsWith('SL-')).toBe(true);
    expect(f.startsWith('F-')).toBe(true);
    expect(isValidId(ml)).toBe(true);
    expect(isValidId(sl)).toBe(true);
    expect(isValidId(f)).toBe(true);
  });

  it('isValidId rejects malformed IDs', () => {
    expect(isValidId('not-an-id')).toBe(false);
    expect(isValidId('T-')).toBe(false);
    expect(isValidId('T-tooShort')).toBe(false);
    // Plus signs aren't part of base64url's alphabet.
    expect(isValidId('T-abc+defghi')).toBe(false);
    expect(isValidId('TASK-abcdefghij')).toBe(false);
  });
});

//#endregion

//#region TaskSchema

describe('TaskSchema', () => {
  function validTask() {
    return {
      id: 'T-abcdefghij',
      source: TaskSource.Manual,
      title: 'Refactor X',
      projectRoot: '/repo',
      worktreePath: null,
      branch: null,
      headSha: null,
      reviewStatus: TaskReviewStatus.NotStarted,
      lifecycleStatus: TaskLifecycleStatus.Active,
      paused: false,
      pauseReason: null,
      archivedAt: null,
      hierarchyStatus: null,
      autopilotEnabled: false,
      autopilotState: AutopilotState.Inactive,
      lastAutopilotActivityAt: null,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      lastSeenAt: '2026-04-30T00:00:00.000Z',
    };
  }

  it('accepts a minimal manual task', () => {
    const t = TaskSchema.parse(validTask());
    expect(t.id).toBe('T-abcdefghij');
  });

  it('accepts a structured worktree task', () => {
    const t = TaskSchema.parse({
      ...validTask(),
      source: TaskSource.Worktree,
      worktreePath: '/repo-T1',
      branch: 'feat/x',
      headSha: 'deadbeef',
      hierarchyStatus: HierarchyStatus.Planning,
      autopilotEnabled: true,
      autopilotState: AutopilotState.Watching,
      lastAutopilotActivityAt: '2026-04-30T00:00:00.000Z',
    });
    expect(t.hierarchyStatus).toBe(HierarchyStatus.Planning);
    expect(t.branch).toBe('feat/x');
  });

  it('rejects an empty title', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      title: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown source', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      source: 'github-pr',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed id', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      id: 'task-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown reviewStatus', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      reviewStatus: 'in-flight',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown lifecycleStatus', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      lifecycleStatus: 'closed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown autopilotState', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      autopilotState: 'paused',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean paused field', () => {
    const result = TaskSchema.safeParse({
      ...validTask(),
      paused: 'no',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when worktreePath is undefined (must be string|null)', () => {
    const { worktreePath: _omit, ...rest } = validTask();
    expect(TaskSchema.safeParse(rest).success).toBe(false);
  });
});

//#endregion

//#region LogEntrySchema

describe('LogEntrySchema', () => {
  it('accepts each kind', () => {
    for (const kind of [
      LogEntryKind.Log,
      LogEntryKind.Comment,
      LogEntryKind.Steer,
      LogEntryKind.System,
    ]) {
      expect(
        LogEntrySchema.safeParse({
          kind,
          ts: '2026-04-30T00:00:00.000Z',
          message: 'x',
        }).success,
      ).toBe(true);
    }
  });

  it('accepts chunk metadata', () => {
    const e = LogEntrySchema.parse({
      kind: LogEntryKind.Log,
      ts: '2026-04-30T00:00:00.000Z',
      message: 'partial',
      chunk: 2,
      chunkCount: 3,
    });
    expect(e.chunk).toBe(2);
    expect(e.chunkCount).toBe(3);
  });

  it('rejects an unknown kind', () => {
    expect(
      LogEntrySchema.safeParse({
        kind: 'note',
        ts: '2026-04-30T00:00:00.000Z',
        message: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects non-positive chunk numbers', () => {
    expect(
      LogEntrySchema.safeParse({
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'x',
        chunk: 0,
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region EventSchema

describe('EventSchema', () => {
  it('accepts a task:created event', () => {
    const e = EventSchema.parse({
      id: 1,
      taskId: 'T-abcdefghij',
      kind: EventKind.TaskCreated,
      ts: '2026-04-30T00:00:00.000Z',
    });
    expect(e.id).toBe(1);
  });

  it('accepts a hierarchy event with null taskId', () => {
    const e = EventSchema.parse({
      id: 2,
      taskId: null,
      kind: EventKind.MilestoneCreated,
      ts: '2026-04-30T00:00:00.000Z',
      payload: {
        milestoneId: 'ML-x',
      },
    });
    expect(e.taskId).toBeNull();
    expect(e.payload?.milestoneId).toBe('ML-x');
  });

  it('rejects a negative id', () => {
    const r = EventSchema.safeParse({
      id: -1,
      taskId: null,
      kind: EventKind.TaskCreated,
      ts: '2026-04-30T00:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const r = EventSchema.safeParse({
      id: 1,
      taskId: null,
      kind: 'task:exploded',
      ts: '2026-04-30T00:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });
});

//#endregion

//#region StateSchema

describe('StateSchema', () => {
  it('accepts a fresh state', () => {
    expect(
      StateSchema.parse({
        schemaVersion: 1,
        lastEventId: 0,
      }),
    ).toEqual({
      schemaVersion: 1,
      lastEventId: 0,
    });
  });

  it('rejects schemaVersion 0', () => {
    expect(
      StateSchema.safeParse({
        schemaVersion: 0,
        lastEventId: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects negative lastEventId', () => {
    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        lastEventId: -1,
      }).success,
    ).toBe(false);
  });
});

//#endregion
