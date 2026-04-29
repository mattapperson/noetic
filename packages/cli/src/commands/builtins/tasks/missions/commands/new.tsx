/**
 * `/mission new` — interactive mission creation.
 *
 * Drives a structured interview via the injectable `runInterview` callback,
 * persists the resulting tree to SQLite, then asks the user about autopilot.
 *
 * Wiring rationale: the slash-command CommandContext does not currently expose
 * the harness or askUserService, and `interview()` from `@noetic/core` is a
 * Step that requires `harness.run()`. We accept these collaborators as props
 * with explicit defaults so:
 *   - Tests inject canned implementations to assert on both `complete` and
 *     `maxQuestions` branches.
 *   - The TUI can construct a wired-up version once the harness/askUser plumbing
 *     reaches the slash-command layer.
 *
 * The default `runInterview` returns `maxQuestions` immediately with a clear
 * "not yet wired" message. The persist/autopilot/onDone flow is fully tested
 * via the injected variant.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { ensureDaemon } from '../../../../../daemon-runtime/runtime.js';
import { useTheme } from '../../../../../tui/components/theme.js';
import type { LocalJsxCommandOnDone } from '../../../../types.js';
import type { MissionRecord } from '../../db/schema.js';
import type { MissionTreeInput } from '../store.js';
import { persistMissionTree, updateMission } from '../store.js';

//#region Types

/** Question envelope passed to the interview question handler. */
export interface InterviewQuestionEnvelope {
  id: string;
  type: 'single_select' | 'multi_select' | 'confirm' | 'text';
  question: string;
  description?: string;
  options?: ReadonlyArray<{
    id: string;
    label: string;
    description?: string;
  }>;
}

/** Completion envelope returned by the interview when the model finishes. */
export interface InterviewCompleteEnvelope extends MissionTreeInput {}

/** Result shape mirrors `@noetic/core`'s `InterviewResult` (wider than this surface needs). */
export type InterviewResultLike =
  | {
      status: 'complete';
      envelope: InterviewCompleteEnvelope;
    }
  | {
      status: 'maxQuestions';
      lastQuestion?: InterviewQuestionEnvelope;
      reason?: string;
    };

/**
 * Injection seam for the LLM-driven interview. Production wiring will pass an
 * implementation that runs the `@noetic/core` `interview()` step against the
 * active harness and routes questions through the askUser modal.
 */
export type RunInterviewFn = () => Promise<InterviewResultLike>;

const defaultRunInterview: RunInterviewFn = async () => ({
  status: 'maxQuestions',
  reason: 'AI interview not yet wired into the slash-command surface.',
});

export type AutopilotChoice = 'yes' | 'no' | 'first-slice-only';

/** Injection seam for the autopilot follow-up prompt. */
export type AskAutopilotFn = (mission: MissionRecord) => Promise<AutopilotChoice>;

const defaultAskAutopilot: AskAutopilotFn = async () => 'no';

export interface MissionNewContainerProps {
  cwd: string;
  onDone: LocalJsxCommandOnDone;
  runInterview?: RunInterviewFn;
  askAutopilot?: AskAutopilotFn;
  ensureDaemonFn?: (cwd: string) => void;
  /** Test seam: persist function override. */
  persistMissionTreeFn?: (cwd: string, tree: MissionTreeInput) => MissionRecord;
  /** Test seam: update mission function override. */
  updateMissionFn?: (cwd: string, id: string, patch: Partial<MissionRecord>) => MissionRecord;
}

export type Phase =
  | {
      kind: 'running';
    }
  | {
      kind: 'maxQuestions';
      message: string;
    }
  | {
      kind: 'persisting';
      tree: InterviewCompleteEnvelope;
    }
  | {
      kind: 'autopilotPrompt';
      mission: MissionRecord;
    }
  | {
      kind: 'completing';
      message: string;
    };

/** @public Cancellable session token used by {@link driveMissionNew}. */
export interface DriveSession {
  cancelled: boolean;
}

/** @public Argument bag for {@link driveMissionNew}. Exported so tests can drive the flow without rendering Ink. */
export interface DriveMissionNewArgs {
  session: DriveSession;
  cwd: string;
  runInterview: RunInterviewFn;
  askAutopilot: AskAutopilotFn;
  ensureDaemonFn: (cwd: string) => void;
  persistMissionTreeFn: (cwd: string, tree: MissionTreeInput) => MissionRecord;
  updateMissionFn: (cwd: string, id: string, patch: Partial<MissionRecord>) => MissionRecord;
  onDone: LocalJsxCommandOnDone;
  setPhase: (phase: Phase) => void;
}

/** @public Drives the mission-new state machine: interview → persist → autopilot prompt → onDone. */
export async function driveMissionNew(args: DriveMissionNewArgs): Promise<void> {
  const {
    session,
    cwd,
    runInterview,
    askAutopilot,
    ensureDaemonFn,
    persistMissionTreeFn,
    updateMissionFn,
    onDone,
    setPhase,
  } = args;
  const result = await runInterview();
  if (session.cancelled) {
    return;
  }
  if (result.status === 'maxQuestions') {
    const lastQuestion = result.lastQuestion?.question;
    const reason = result.reason ?? 'Interview ended without a complete plan.';
    const message =
      lastQuestion !== undefined ? `${reason} Last question: ${lastQuestion}` : reason;
    setPhase({
      kind: 'maxQuestions',
      message,
    });
    onDone(`Mission interview did not complete: ${message}`);
    return;
  }
  setPhase({
    kind: 'persisting',
    tree: result.envelope,
  });
  const mission = persistMissionTreeFn(cwd, result.envelope);
  const choice = await askAutopilot(mission);
  if (session.cancelled) {
    return;
  }
  const enable = choice === 'yes' || choice === 'first-slice-only';
  if (enable) {
    updateMissionFn(cwd, mission.id, {
      autopilotEnabled: true,
      autopilotState: 'watching',
    });
    ensureDaemonFn(cwd);
  }
  const summary = `Mission "${mission.title}" created (${mission.id}).${
    enable ? ' Autopilot enabled.' : ''
  }`;
  setPhase({
    kind: 'completing',
    message: summary,
  });
  onDone(summary);
}

//#endregion

//#region Component

export function MissionNewContainer(props: MissionNewContainerProps): ReactNode {
  const {
    cwd,
    onDone,
    runInterview = defaultRunInterview,
    askAutopilot = defaultAskAutopilot,
    ensureDaemonFn = ensureDaemon,
    persistMissionTreeFn = persistMissionTree,
    updateMissionFn = updateMission,
  } = props;
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({
    kind: 'running',
  });

  useEffect(() => {
    const session = {
      cancelled: false,
    };
    const drive = async (): Promise<void> => {
      try {
        await driveMissionNew({
          session,
          cwd,
          runInterview,
          askAutopilot,
          ensureDaemonFn,
          persistMissionTreeFn,
          updateMissionFn,
          onDone,
          setPhase,
        });
      } catch (err) {
        if (session.cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setPhase({
          kind: 'completing',
          message: `Mission creation failed: ${message}`,
        });
        onDone(`Mission creation failed: ${message}`);
      }
    };
    void drive();
    return () => {
      session.cancelled = true;
    };
  }, [
    cwd,
    runInterview,
    askAutopilot,
    persistMissionTreeFn,
    updateMissionFn,
    ensureDaemonFn,
    onDone,
  ]);

  useInput((input, key) => {
    if (phase.kind === 'maxQuestions' || phase.kind === 'completing') {
      if (key.escape || input === 'q' || key.return) {
        onDone(phase.kind === 'maxQuestions' ? 'Mission interview cancelled.' : phase.message);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
      <Text color={theme.primary}>New mission</Text>
      <PhaseView phase={phase} />
      <Box marginTop={1}>
        <Text dimColor>Press q/Esc/Enter to dismiss.</Text>
      </Box>
    </Box>
  );
}

interface PhaseViewProps {
  phase: Phase;
}

function PhaseView({ phase }: PhaseViewProps): ReactNode {
  if (phase.kind === 'running') {
    return <Text dimColor>Running interview…</Text>;
  }
  if (phase.kind === 'maxQuestions') {
    return <Text>{phase.message}</Text>;
  }
  if (phase.kind === 'persisting') {
    return <Text dimColor>Persisting mission tree…</Text>;
  }
  if (phase.kind === 'autopilotPrompt') {
    return <Text dimColor>Awaiting autopilot decision…</Text>;
  }
  return <Text>{phase.message}</Text>;
}

//#endregion

//#region Renderer entry

export interface RenderMissionNewArgs {
  cwd: string;
  onDone: LocalJsxCommandOnDone;
  runInterview?: RunInterviewFn;
  askAutopilot?: AskAutopilotFn;
}

export function renderMissionNew(args: RenderMissionNewArgs): ReactNode {
  return (
    <MissionNewContainer
      cwd={args.cwd}
      onDone={args.onDone}
      runInterview={args.runInterview}
      askAutopilot={args.askAutopilot}
    />
  );
}

//#endregion
