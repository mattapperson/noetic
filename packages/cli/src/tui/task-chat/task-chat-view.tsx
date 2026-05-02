/**
 * Renders a chat session against a running task agent.
 *
 * Wraps `useTaskChat` (the IPC-backed hook) and feeds its entries into
 * the same `ResponsesChat` component the in-process chat uses. The
 * header strip shows what role you're chatting with (planner /
 * implementer / validator), the task id, and the connection state.
 */

import { Box, Text, useInput } from 'ink';
import type React from 'react';
import type { ChatStatus } from '../components/prompt-input.js';
import { ResponsesChat } from '../components/responses-chat.js';
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

export function TaskChatView(props: TaskChatViewProps): React.ReactElement {
  const chat = useTaskChat({
    socketPath: props.socketPath,
  });

  useInput((_input, key) => {
    if (key.escape) {
      props.onExit();
    }
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
    </Box>
  );
}

//#endregion
