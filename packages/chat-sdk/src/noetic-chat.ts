import type { ExecuteInput, ExecuteOptions, HarnessResponse, SessionScope } from '@noetic-tools/core';
import type {
  ActionHandler,
  Adapter,
  AppHomeOpenedHandler,
  AssistantContextChangedHandler,
  AssistantThreadStartedHandler,
  Author,
  Channel,
  DirectMessageHandler,
  MemberJoinedChannelHandler,
  Message,
  MessageHandler,
  ModalCloseHandler,
  ModalSubmitHandler,
  ReactionHandler,
  SlashCommandHandler,
  Thread,
} from 'chat';
import { Chat } from 'chat';

import { chatStream } from './chat-stream';
import { getChatToolRender } from './chat-tool';
import { toNoeticItems } from './messages';
import type { NoeticChatConfig, NoeticMentionHandler, NoeticSubscribedHandler } from './types';

//#region Constants

const DEFAULT_MAX_HISTORY = 20;

//#endregion

//#region Helper

async function collectMessages(thread: Thread, maxMessages: number): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const msg of thread.allMessages) {
    messages.push(msg);
    if (messages.length >= maxMessages) {
      break;
    }
  }
  return messages;
}

async function postToolCards(thread: Thread, response: HarnessResponse): Promise<void> {
  for (const item of response.items) {
    if (item.type !== 'function_call_output') {
      continue;
    }
    const render = getChatToolRender(findToolNameForCallId(response.items, item.callId));
    if (!render) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.output);
    } catch {
      parsed = item.output;
    }
    const card = render(parsed);
    if (card !== null && card !== undefined) {
      await thread.post(card);
    }
  }
}

function findToolNameForCallId(
  items: ReadonlyArray<{
    type: string;
    name?: string;
    callId?: string;
  }>,
  callId: string,
): string {
  for (const item of items) {
    if (item.type === 'function_call' && item.callId === callId) {
      return item.name ?? '';
    }
  }
  return '';
}

/** Minimal harness surface used by `buildThreadExecuteFn`. Production callers
 *  satisfy this via the full `AgentHarness` class; tests can stub it directly. */
interface HarnessExecuteSurface {
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse>;
}

/** Construct a per-thread `executeFn` that routes enqueue + response through
 *  the thread's session. Exported for testing; production code calls it via
 *  `NoeticChat#buildExecuteFn`. */
export function buildThreadExecuteFn(
  harness: HarnessExecuteSurface,
  threadId: string,
): (input?: ExecuteInput) => Promise<HarnessResponse> {
  return async (input) => {
    await harness.execute(input ?? '', {
      threadId,
    });
    return harness.getAgentResponse({
      threadId,
    });
  };
}

//#endregion

//#region NoeticChat

/**
 * Composed wrapper around chat-sdk's Chat class with Noetic agent execution baked in.
 *
 * - Auto-executes a Noetic step on mentions and subscribed messages by default
 * - Streams responses via chatStream() (paragraph breaks between tool rounds)
 * - Posts tool result cards when chatTool render functions are registered
 * - Supports override handlers that receive an execute convenience function
 *
 * @public
 */
export class NoeticChat<TAdapters extends Record<string, Adapter> = Record<string, Adapter>> {
  private readonly chat: Chat<TAdapters>;
  private readonly config: NoeticChatConfig<TAdapters>;
  private customMentionHandler?: NoeticMentionHandler;
  private customSubscribedHandler?: NoeticSubscribedHandler;

  constructor(config: NoeticChatConfig<TAdapters>) {
    this.config = config;
    const { harness, autoSubscribe, singleTurn, maxHistoryMessages, tools, ...chatConfig } = config;
    this.chat = new Chat(chatConfig);

    this.chat.onNewMention(async (thread, message) => {
      await this.handleMention(thread, message);
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      await this.handleSubscribed(thread, message);
    });
  }

  //#region Event Handlers (with Noetic override support)

  /** Override the default mention handler. Receives an execute convenience function. */
  onNewMention(handler: NoeticMentionHandler): void {
    this.customMentionHandler = handler;
  }

  /** Override the default subscribed message handler. Receives an execute convenience function. */
  onSubscribedMessage(handler: NoeticSubscribedHandler): void {
    this.customSubscribedHandler = handler;
  }

  //#endregion

  //#region Delegated Event Handlers

  onDirectMessage(handler: DirectMessageHandler): void {
    this.chat.onDirectMessage(handler);
  }

  onNewMessage(pattern: RegExp, handler: MessageHandler): void {
    this.chat.onNewMessage(pattern, handler);
  }

  onReaction(handlerOrEmoji: ReactionHandler | Array<string>, handler?: ReactionHandler): void {
    if (!Array.isArray(handlerOrEmoji)) {
      this.chat.onReaction(handlerOrEmoji);
      return;
    }
    if (!handler) {
      return;
    }
    this.chat.onReaction(handlerOrEmoji, handler);
  }

  onAction(handlerOrIds: ActionHandler | string[] | string, handler?: ActionHandler): void {
    if (typeof handlerOrIds === 'function') {
      this.chat.onAction(handlerOrIds);
      return;
    }
    if (!handler) {
      return;
    }
    this.chat.onAction(handlerOrIds, handler);
  }

  onModalSubmit(
    handlerOrIds: ModalSubmitHandler | string[] | string,
    handler?: ModalSubmitHandler,
  ): void {
    if (typeof handlerOrIds === 'function') {
      this.chat.onModalSubmit(handlerOrIds);
      return;
    }
    if (!handler) {
      return;
    }
    this.chat.onModalSubmit(handlerOrIds, handler);
  }

  onModalClose(
    handlerOrIds: ModalCloseHandler | string[] | string,
    handler?: ModalCloseHandler,
  ): void {
    if (typeof handlerOrIds === 'function') {
      this.chat.onModalClose(handlerOrIds);
      return;
    }
    if (!handler) {
      return;
    }
    this.chat.onModalClose(handlerOrIds, handler);
  }

  onSlashCommand(
    handlerOrCommands: SlashCommandHandler | string[] | string,
    handler?: SlashCommandHandler,
  ): void {
    if (typeof handlerOrCommands === 'function') {
      this.chat.onSlashCommand(handlerOrCommands);
      return;
    }
    if (!handler) {
      return;
    }
    this.chat.onSlashCommand(handlerOrCommands, handler);
  }

  onAssistantThreadStarted(handler: AssistantThreadStartedHandler): void {
    this.chat.onAssistantThreadStarted(handler);
  }

  onAssistantContextChanged(handler: AssistantContextChangedHandler): void {
    this.chat.onAssistantContextChanged(handler);
  }

  onAppHomeOpened(handler: AppHomeOpenedHandler): void {
    this.chat.onAppHomeOpened(handler);
  }

  onMemberJoinedChannel(handler: MemberJoinedChannelHandler): void {
    this.chat.onMemberJoinedChannel(handler);
  }

  //#endregion

  //#region Delegated Methods

  get webhooks(): Chat<TAdapters>['webhooks'] {
    return this.chat.webhooks;
  }

  getAdapter<K extends keyof TAdapters>(name: K): TAdapters[K] {
    return this.chat.getAdapter(name);
  }

  async openDM(user: string | Author): Promise<Thread> {
    return this.chat.openDM(user);
  }

  channel(channelId: string): Channel {
    return this.chat.channel(channelId);
  }

  async initialize(): Promise<void> {
    return this.chat.initialize();
  }

  async shutdown(): Promise<void> {
    return this.chat.shutdown();
  }

  reviver(): (key: string, value: unknown) => unknown {
    return this.chat.reviver();
  }

  //#endregion

  //#region Internal Handlers

  private async handleMention(thread: Thread, message: Message): Promise<void> {
    if (this.customMentionHandler) {
      const executeFn = this.buildExecuteFn(thread);
      await this.customMentionHandler(thread, message, executeFn);
      return;
    }

    await this.autoExecute(thread);
  }

  private async handleSubscribed(thread: Thread, message: Message): Promise<void> {
    if (this.customSubscribedHandler) {
      const executeFn = this.buildExecuteFn(thread);
      await this.customSubscribedHandler(thread, message, executeFn);
      return;
    }

    await this.autoExecute(thread);
  }

  /** Bind the per-thread session so callers don't share the harness's default thread. */
  private buildExecuteFn(thread: Thread): (input?: ExecuteInput) => Promise<HarnessResponse> {
    return buildThreadExecuteFn(this.config.harness, thread.id);
  }

  private async autoExecute(thread: Thread): Promise<void> {
    const shouldSubscribe = !this.config.singleTurn && this.config.autoSubscribe !== false;

    if (shouldSubscribe) {
      await thread.subscribe();
    }

    const threadId = thread.id;
    const maxHistory = this.config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY;
    const historyMessages = await collectMessages(thread, maxHistory);
    const items = toNoeticItems(historyMessages);

    await this.config.harness.execute(items, {
      threadId,
    });

    await thread.post(
      chatStream(
        this.config.harness.getFullStream({
          threadId,
        }),
      ),
    );
    const response = await this.config.harness.getAgentResponse({
      threadId,
    });
    await postToolCards(thread, response);
  }

  //#endregion
}

//#endregion
