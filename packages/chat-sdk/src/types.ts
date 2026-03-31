import type { AgentHarness, ExecuteInput, HarnessResult, Tool } from '@noetic/core';
import type { Adapter, ChatConfig, ChatElement, Message, Thread } from 'chat';
import type { ZodTypeAny } from 'zod';

/** @public Accepted return types from a chatTool render function. */
export type ChatToolRenderable = string | ChatElement | null | undefined;

//#region ChatTool Types

/** @public A Noetic Tool extended with a chat-sdk card render function. */
export interface ChatTool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny>
  extends Tool<I, O> {
  /** Render tool output as a chat-sdk card or string for posting. */
  render?: (output: unknown) => ChatToolRenderable;
}

//#endregion

//#region NoeticChat Config

/** @public Handler that receives an execute convenience function alongside thread and message. */
export type NoeticMentionHandler = (
  thread: Thread,
  message: Message,
  execute: (input?: ExecuteInput) => HarnessResult,
) => void | Promise<void>;

/** @public Handler for subscribed thread messages with execute convenience. */
export type NoeticSubscribedHandler = (
  thread: Thread,
  message: Message,
  execute: (input?: ExecuteInput) => HarnessResult,
) => void | Promise<void>;

/** @public Mode for converting modal form values to Noetic input. */
export const ModalInputMode = {
  /** Serialize values as a readable user message string. */
  Message: 'message',
  /** Pass values object directly as structured input. */
  Structured: 'structured',
} as const;

export type ModalInputMode = (typeof ModalInputMode)[keyof typeof ModalInputMode];

/** @public Options for modal-to-Noetic input conversion. */
export interface ModalInputOptions {
  /** Conversion mode. Defaults to 'message'. */
  mode?: ModalInputMode;
  /** Custom mapper function. When provided, mode is ignored. */
  mapper?: (
    values: Record<string, string>,
    event: {
      values: Record<string, string>;
      callbackId: string;
    },
  ) => ExecuteInput;
}

/** @public Configuration for NoeticChat, extending ChatConfig with Noetic-specific options. */
export interface NoeticChatConfig<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> extends ChatConfig<TAdapters> {
  /** Noetic AgentHarness instance (must have initialStep configured). */
  harness: AgentHarness;
  /** Auto-subscribe threads on first mention. Defaults to true. */
  autoSubscribe?: boolean;
  /** Disable auto-subscribe entirely. Defaults to false. */
  singleTurn?: boolean;
  /** Maximum number of thread messages to load as conversation context. Defaults to 20. */
  maxHistoryMessages?: number;
  /** Chat tools with optional card render functions. Used by auto-execute to post cards after tool calls. */
  tools?: ChatTool[];
}

//#endregion
