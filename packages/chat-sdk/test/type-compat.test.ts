import { expect, test } from 'bun:test';
import type { Message, StreamChunk, Thread } from 'chat';
import type { ChatMessageLike, ChatStreamChunk, ChatThreadLike } from '../src/chat-types';

/**
 * Compile-time pins between our structural mirrors and the real `chat`
 * package (a devDependency here, an optional peer for consumers). Never
 * called — if `chat` changes shape, `bun run typecheck` fails.
 */
export function realShapesSatisfyMirrors(
  thread: Thread,
  message: Message,
  chunk: ChatStreamChunk,
): void {
  const threadLike: ChatThreadLike = thread;
  const messageLike: ChatMessageLike = message;
  // Chunks we produce must be postable to a real thread.
  const postable: StreamChunk = chunk;
  void threadLike;
  void messageLike;
  void postable;
}

test('mirrors compile against the real chat package', () => {
  expect(typeof realShapesSatisfyMirrors).toBe('function');
});
