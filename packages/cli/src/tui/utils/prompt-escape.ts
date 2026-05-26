import type { ChatStatus } from '../chat-status.js';

//#region Types

export type PromptEscapeAction =
  | 'close-modal'
  | 'clear-input'
  | 'dismiss-suggestions'
  | 'stop'
  | 'noop';

export interface PromptEscapeOptions {
  readonly value: string;
  readonly status?: ChatStatus;
  readonly suggestionCount: number;
  readonly isModalOpen: boolean;
  readonly hasModalClose: boolean;
  readonly hasStop: boolean;
}

//#endregion

//#region Public API

export function resolvePromptEscapeAction(options: PromptEscapeOptions): PromptEscapeAction {
  if (options.isModalOpen && options.hasModalClose) {
    return 'close-modal';
  }
  if (options.value.length > 0) {
    return 'clear-input';
  }
  if (options.suggestionCount > 0) {
    return 'dismiss-suggestions';
  }
  if (options.hasStop && (options.status === 'streaming' || options.status === 'submitted')) {
    return 'stop';
  }
  return 'noop';
}

//#endregion
