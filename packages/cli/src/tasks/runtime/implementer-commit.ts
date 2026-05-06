import { EventKind, LogEntryKind } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent, appendLog } from '@noetic/code-agent/tasks/store/fs-node';
import type { FeatureLifecycleContext } from './hierarchy/feature-lifecycle.js';
import { applyFeatureLoopStateUpdate } from './hierarchy/feature-lifecycle.js';
import type { ImplementerOutcome } from './hierarchy/implementer-flow.js';
import { FeatureLoopState } from './hierarchy/schemas.js';

function nowIso(): string {
  return new Date().toISOString();
}

interface CommitExitWritesArgs {
  readonly ctx: TaskStoreContext;
  readonly leafTaskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly outcome: ImplementerOutcome;
}

interface CommitExitWritesResult {
  readonly previousLoopState: FeatureLoopState;
  readonly loopState: FeatureLoopState;
}

/**
 * Audit → state → event commit on runner exit. Pure — testable without
 * an AgentHarness. The leaf task gets the durable log line; the parent
 * gets the canonical loopState mutation and the bus event.
 */
export async function commitExitWrites(
  args: CommitExitWritesArgs,
): Promise<CommitExitWritesResult> {
  const ts = nowIso();

  const summary =
    args.outcome.status === 'completed'
      ? `implementer completed: ${args.outcome.summary}`
      : `implementer blocked: ${args.outcome.summary}`;
  await appendLog(args.ctx, {
    taskId: args.leafTaskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: summary,
    },
  });

  const parentCtx: FeatureLifecycleContext = {
    ...args.ctx,
    taskId: args.parentTaskId,
  };
  const change =
    args.outcome.status === 'completed'
      ? await applyFeatureLoopStateUpdate(parentCtx, {
          featureId: args.featureId,
          newLoopState: FeatureLoopState.Validating,
        })
      : await applyFeatureLoopStateUpdate(parentCtx, {
          featureId: args.featureId,
          newLoopState: FeatureLoopState.Blocked,
          blockedReason: args.outcome.blockedReason ?? args.outcome.summary,
        });

  const previousLoopState = change.changed?.previousLoopState ?? change.feature.loopState;
  const loopState = change.feature.loopState;

  await appendEvent(args.ctx, {
    taskId: args.parentTaskId,
    kind: EventKind.FeatureLoopStateChanged,
    payload: {
      featureId: args.featureId,
      leafTaskId: args.leafTaskId,
      previousLoopState,
      loopState,
      phase: 'exit',
      summary: args.outcome.summary,
    },
    ts,
  });

  return {
    previousLoopState,
    loopState,
  };
}
