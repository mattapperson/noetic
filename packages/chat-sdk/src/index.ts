// Re-export everything from chat-sdk.
// Note: chat-sdk exports its own StreamEvent type; users needing Noetic's
// StreamEvent should import it from @noetic/core directly.
export * from 'chat';

// Noetic adapter exports
export { chatStream } from './chat-stream';
export type { ChatToolConfig } from './chat-tool';
export { chatTool, clearChatToolRegistry, getChatToolRender } from './chat-tool';
export { toNoeticItems } from './messages';
export type { ModalSubmitValues } from './modals';
export { modalToNoeticInput } from './modals';
export { NoeticChat } from './noetic-chat';
export type {
  ChatTool,
  ChatToolRenderable,
  ModalInputOptions,
  NoeticChatConfig,
  NoeticMentionHandler,
  NoeticSubscribedHandler,
} from './types';
export { ModalInputMode } from './types';
