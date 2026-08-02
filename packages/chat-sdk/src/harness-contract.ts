import type {
  ChannelHandle,
  ExecuteInput,
  ExecuteOptions,
  ExternalChannel,
  HarnessStatus,
  Item,
  SessionScope,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';

/**
 * Structural subset of `AgentHarnessContract` that `noeticAgent` drives.
 * Mirrors the pattern of platform-node's `IpcHarness`: depending on the
 * narrow surface keeps mocks small and the package coupled only to
 * `@noetic-tools/types`.
 */
export interface ChatHarness {
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent>;
  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem>;
  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void;
  /** Write side of the approval flow — see `approvals.ts`. */
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
  /** Read side of the approval flow — subscribe with `APPROVAL_SCOPE`. */
  getChannelStream<T>(channel: ExternalChannel<T>, executionId: string): AsyncIterable<T>;
  getStatus(scope?: SessionScope): HarnessStatus;
  getQueueSize(scope?: SessionScope): number;
  abort(
    scope?: SessionScope & {
      reason?: string;
    },
  ): Promise<void>;
}
