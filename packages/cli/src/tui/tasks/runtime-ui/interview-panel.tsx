/**
 * AI-driven planning panel. Drives the live `interview()` step (via
 * `createLiveRunInterview`) inside a kanban-board overlay. Phase
 * transitions:
 *
 *  - `idle`       — initial; we haven't started the interview yet.
 *  - `running`    — the harness/askUser exchange is mid-flight.
 *  - `persisting` — the structured plan is being written to disk.
 *  - `done`       — terminal; `onDone` was called.
 *  - `error`      — the interview or persistence failed.
 *
 * The state machine is exposed as `drivePlanInterview` so it can be
 * unit-tested without an Ink mount or a live LLM. The Ink wrapper
 * just renders the current phase and forwards `Esc` to cancel.
 */

import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent } from '@noetic/code-agent/tasks/store/fs-node';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTheme } from '../../components/theme.js';
import type { InterviewResultLike } from '../../../tasks/runtime/hierarchy/live-interview.js';
import { persistTaskHierarchy } from '../../../tasks/runtime/hierarchy/persist.js';

//#region Types

/** Discriminated union describing interview-panel state. */
export type Phase =
  | {
      kind: 'idle';
    }
  | {
      kind: 'running';
    }
  | {
      kind: 'persisting';
    }
  | {
      kind: 'done';
      summary: string;
    }
  | {
      kind: 'error';
      message: string;
    };

export interface DrivePlanInterviewArgs {
  /** Mints the live interview promise — typically `createLiveRunInterview`. */
  readonly runInterview: () => Promise<InterviewResultLike>;
  /** Persistence helper — receives the interview's structured envelope. */
  readonly persist: (
    envelope: InterviewResultLike & {
      status: 'complete';
    },
  ) => Promise<void>;
  /** Reports phase transitions; consumers usually wire this into React state. */
  readonly setPhase: (phase: Phase) => void;
  /** Optional outbound notification for "session is done". */
  readonly onDone?: (summary: string) => void;
  /** Cancellation latch the host can flip mid-run. */
  readonly session: {
    cancelled: boolean;
  };
}

export interface InterviewPanelProps {
  readonly taskId: string;
  readonly task: {
    title: string;
  };
  readonly ctx: TaskStoreContext;
  /** Kicks off the interview (resolves once the LLM emits a complete envelope). */
  readonly runInterview: () => Promise<InterviewResultLike>;
  /** Called once the panel is finished (success, cancel, or error). */
  readonly onDone: (summary: string) => void;
}

//#endregion

//#region State machine

/** Format a "did not complete" reason for the maxQuestions branch. */
export function formatMaxQuestionsSummary(
  result: InterviewResultLike & {
    status: 'maxQuestions';
  },
): string {
  const last = result.lastQuestion?.question;
  const reason = result.reason ?? 'Interview did not complete.';
  if (last === undefined) {
    return `${reason}`;
  }
  return `${reason} Last question: ${last}`;
}

/**
 * Drive the planning state machine. Pure helper — no Ink imports — so
 * tests can exercise every branch by injecting fakes.
 *
 * Order of operations:
 *  1. setPhase(running) and await `runInterview()`.
 *  2. If cancelled, emit nothing and short-circuit.
 *  3. On `complete`: setPhase(persisting), call `persist`, then `done`.
 *  4. On `maxQuestions`: skip persistence and report a friendly summary.
 *  5. Any throw lands as `error`.
 */
export async function drivePlanInterview(args: DrivePlanInterviewArgs): Promise<void> {
  args.setPhase({
    kind: 'running',
  });
  let result: InterviewResultLike;
  try {
    result = await args.runInterview();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.setPhase({
      kind: 'error',
      message,
    });
    return;
  }
  if (args.session.cancelled) {
    return;
  }
  if (result.status === 'maxQuestions') {
    const summary = formatMaxQuestionsSummary(result);
    args.setPhase({
      kind: 'done',
      summary,
    });
    args.onDone?.(summary);
    return;
  }
  args.setPhase({
    kind: 'persisting',
  });
  try {
    await args.persist(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.setPhase({
      kind: 'error',
      message,
    });
    return;
  }
  if (args.session.cancelled) {
    return;
  }
  const summary = `Plan saved (${result.envelope.milestones.length} milestone${
    result.envelope.milestones.length === 1 ? '' : 's'
  }).`;
  args.setPhase({
    kind: 'done',
    summary,
  });
  args.onDone?.(summary);
}

//#endregion

//#region Component

export function InterviewPanel(props: InterviewPanelProps): React.ReactElement {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({
    kind: 'idle',
  });

  useEffect(() => {
    const session = {
      cancelled: false,
    };
    void drivePlanInterview({
      session,
      runInterview: props.runInterview,
      persist: async (result) => {
        await persistTaskHierarchy(props.ctx, props.taskId, result.envelope);
        await appendEvent(props.ctx, {
          taskId: props.taskId,
          kind: 'mission:statusChanged',
          ts: new Date().toISOString(),
          payload: {
            status: 'planning-complete',
          },
        });
      },
      setPhase,
      onDone: props.onDone,
    });
    return () => {
      session.cancelled = true;
    };
  }, [
    props.ctx,
    props.taskId,
    props.runInterview,
    props.onDone,
  ]);

  useInput((_input, key) => {
    if (key.escape) {
      props.onDone('Plan interview cancelled.');
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.border}>
      <Text color={theme.primary}>Plan: {props.task.title}</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>{describePhase(phase)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>Esc to cancel</Text>
      </Box>
    </Box>
  );
}

/** Pure formatter: render a phase as a single-line status string. */
export function describePhase(phase: Phase): string {
  if (phase.kind === 'idle') {
    return 'Ready.';
  }
  if (phase.kind === 'running') {
    return 'Asking questions...';
  }
  if (phase.kind === 'persisting') {
    return 'Saving plan...';
  }
  if (phase.kind === 'done') {
    return phase.summary;
  }
  return `Error: ${phase.message}`;
}

//#endregion
