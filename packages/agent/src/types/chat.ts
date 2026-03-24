/**
 * Chat UI state types — maps StreamableOutputItem to Gridland Chat component props.
 */

//#region Constants

export const ChatStatus = {
  Ready: 'ready',
  Submitted: 'submitted',
  Streaming: 'streaming',
  Error: 'error',
} as const;

export type ChatStatus = (typeof ChatStatus)[keyof typeof ChatStatus];

//#endregion

//#region Types

export interface ToolCallDisplay {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallDisplay[];
  reasoning?: string;
}

export interface AgentState {
  messages: ChatMessage[];
  status: ChatStatus;
  streamingText: string;
  activeToolCalls: ToolCallDisplay[];
  tokenUsage: {
    input: number;
    output: number;
  };
}

//#endregion
