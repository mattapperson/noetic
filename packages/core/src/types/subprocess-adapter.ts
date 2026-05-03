export type SubprocessStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'stale';

export interface SubprocessRequest {
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  stdin?: string;
  metadata?: Record<string, unknown>;
}

export interface SubprocessHandle {
  id: string;
  status: SubprocessStatus;
  startedAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export type SubprocessControlResult =
  | {
      kind: 'ok';
      handle: SubprocessHandle;
    }
  | {
      kind: 'unsupported';
      handle: SubprocessHandle;
      message: string;
    }
  | {
      kind: 'not_found';
      handleId: string;
    };

export interface SubprocessStopResult {
  kind: 'stopped' | 'not_found';
  handleId: string;
  handle?: SubprocessHandle;
}

export interface SubprocessAdapter {
  spawn(request: SubprocessRequest): Promise<SubprocessHandle>;
  get(handleId: string): Promise<SubprocessHandle | null>;
  stop(handleId: string, reason?: string): Promise<SubprocessStopResult>;
  pause(handleId: string): Promise<SubprocessControlResult>;
  resume(handleId: string): Promise<SubprocessControlResult>;
  isAlive(handle: SubprocessHandle): Promise<boolean>;
}
