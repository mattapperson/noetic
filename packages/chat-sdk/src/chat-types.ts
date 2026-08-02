/**
 * Structural mirrors of the `chat` (chat-sdk.dev) shapes this package consumes
 * and produces. `chat` is an optional peer dependency: mirroring the handful of
 * fields we touch keeps this package's public types compiling for consumers who
 * haven't installed it. `test/type-compat.test.ts` pins these mirrors against
 * the real package so drift fails CI.
 */

/** Subset of `chat`'s `Author`. */
export interface ChatAuthorLike {
  readonly userId: string;
  readonly userName: string;
  readonly fullName: string;
  readonly isBot: boolean | 'unknown';
  /** True when this bot/runtime sent the message — the assistant-role signal. */
  readonly isMe: boolean;
  readonly isSystem?: boolean;
}

/** Subset of `chat`'s `Attachment`. */
export interface ChatAttachmentLike {
  readonly type: 'image' | 'file' | 'video' | 'audio';
  readonly url?: string;
  readonly name?: string;
  readonly mimeType?: string;
}

/** Subset of `chat`'s `Message`. */
export interface ChatMessageLike {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly author: ChatAuthorLike;
  readonly metadata: {
    readonly dateSent: Date;
    readonly edited: boolean;
  };
  readonly attachments: ReadonlyArray<ChatAttachmentLike>;
  readonly isMention?: boolean;
}

/** Mirror of `chat`'s `MarkdownTextChunk`. */
export interface ChatMarkdownTextChunk {
  readonly type: 'markdown_text';
  readonly text: string;
}

/** Mirror of `chat`'s `TaskUpdateChunk`. */
export interface ChatTaskUpdateChunk {
  readonly type: 'task_update';
  readonly id: string;
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'complete' | 'error';
  readonly details?: string;
  readonly output?: string;
}

/** Mirror of `chat`'s `PlanUpdateChunk`. */
export interface ChatPlanUpdateChunk {
  readonly type: 'plan_update';
  readonly title: string;
}

/** Mirror of `chat`'s `StreamChunk` union. */
export type ChatStreamChunk = ChatMarkdownTextChunk | ChatTaskUpdateChunk | ChatPlanUpdateChunk;

/** Subset of `chat`'s `FetchResult`. */
export interface ChatFetchResult {
  readonly messages: ChatMessageLike[];
  readonly nextCursor?: string;
}

/** Subset of `chat`'s `Thread`: the surface `noeticAgent` drives. */
export interface ChatThreadLike {
  readonly id: string;
  readonly adapter: {
    fetchMessages(
      threadId: string,
      options?: {
        limit?: number;
      },
    ): Promise<ChatFetchResult>;
  };
  post(message: AsyncIterable<string | ChatStreamChunk>): Promise<unknown>;
}
