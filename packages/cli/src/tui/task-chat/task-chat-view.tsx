/**
 * Renders a chat session against a running task agent.
 *
 * Wraps `useTaskChat` (the IPC-backed hook) and feeds its entries into
 * the same `ResponsesChat` component the in-process chat uses. The
 * header strip shows what role you're chatting with (planner /
 * implementer / validator), the task id, and the connection state.
 *
 * When the runner agent has issued an outstanding `AskUserQuestion`,
 * the existing `AskUserModal` is rendered as an overlay over the chat
 * scroll. Submitting / cancelling the modal forwards the user's
 * decision back through the per-task IPC socket so the agent's
 * awaiting tool call resolves.
 */

import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { AskUserModal } from '../components/ask-user/ask-user-modal.js';
import type { ChatStatus } from '../components/prompt-input.js';
import { ResponsesChat } from '../components/responses-chat.js';
import { useTheme } from '../components/theme.js';
import type { TaskChatStatus } from './use-task-chat.js';
import { useTaskChat } from './use-task-chat.js';

//#region Types

export interface TaskChatViewProps {
  /** Path to the runner's IPC unix-domain socket. */
  readonly socketPath: string;
  /** Task id, shown in the header. */
  readonly taskId: string;
  /** Pretty role label shown in the header (planner / implementer / validator). */
  readonly roleLabel: string;
  /** Called when the user presses Esc to leave the view. */
  readonly onExit: () => void;
}

//#endregion

//#region Helpers

function toChatStatus(status: TaskChatStatus): ChatStatus {
  if (status.kind === 'connecting') {
    return 'submitted';
  }
  if (status.kind === 'submitted') {
    return 'submitted';
  }
  if (status.kind === 'streaming') {
    return 'streaming';
  }
  if (status.kind === 'closed') {
    return 'error';
  }
  return 'ready';
}

function describeStatus(status: TaskChatStatus): string {
  if (status.kind === 'connecting') {
    return 'connecting…';
  }
  if (status.kind === 'closed') {
    return `disconnected: ${status.reason}`;
  }
  if (status.kind === 'streaming') {
    return 'agent is streaming';
  }
  if (status.kind === 'submitted') {
    return 'message queued';
  }
  return 'connected';
}

//#endregion

//#region Public component

/**
 * Placeholder view shown while the planner runner is spawning and we wait
 * for the IPC socket to bind. Pure render — `app.tsx` handles the polling
 * and swaps to {@link TaskChatView} once the socket path is known.
 */
export function TaskChatSpawningView(props: {
  readonly taskId: string;
  readonly onExit: () => void;
}): React.ReactElement {
  const theme = useTheme();
  useInput((_input, key) => {
    if (key.escape) {
      props.onExit();
    }
  });
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box flexDirection="row">
        <Text color={theme.primary} bold>
          {`Task ${props.taskId}`}
        </Text>
        <Text color={theme.muted}>{'  ·  starting planner agent…'}</Text>
      </Box>
      <Text color={theme.muted}>Esc to cancel</Text>
    </Box>
  );
}

export function TaskChatView(props: TaskChatViewProps): React.ReactElement {
  const chat = useTaskChat({
    socketPath: props.socketPath,
  });

  // Esc dismisses an open ask-user modal first; only when no modal is
  // open does it fall through to leaving the view. Without this the
  // user would have no way to back out of a stuck question other than
  // clicking the (non-existent) cancel button.
  useInput((_input, key) => {
    if (!key.escape) {
      return;
    }
    if (chat.pendingAskUser !== null) {
      chat.cancelAskUser('user dismissed via escape');
      return;
    }
    props.onExit();
  });

  const handleSubmit = (text: string): void => {
    if (text.trim().length === 0) {
      return;
    }
    void chat.send(text);
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingX={1} marginBottom={1}>
        <Text color="cyan" bold>
          {`Task ${props.taskId}`}
        </Text>
        <Text color="gray">{`  ·  chatting with ${props.roleLabel}  ·  ${describeStatus(chat.status)}`}</Text>
      </Box>
      <ResponsesChat
        entries={[
          ...chat.entries,
        ]}
        status={toChatStatus(chat.status)}
        onSubmit={handleSubmit}
      />
      {chat.pendingAskUser === null ? null : (
        <Box marginTop={1}>
          <AskUserModal
            input={chat.pendingAskUser.input}
            isPlanMode={false}
            onSubmit={(output) => {
              chat.submitAskUser(output);
            }}
            onCancel={(reason) => {
              chat.cancelAskUser(reason);
            }}
            onFinishPlanInterview={() => {
              // Plan mode isn't meaningful in the task-runner chat —
              // the runner agent only ever asks structured questions
              // mid-implementation, never as a plan interview.
            }}
          />
        </Box>
      )}
    </Box>
  );
}

//#endregion
