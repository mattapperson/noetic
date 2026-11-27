import type {
  Context,
  ProcessSubprocessRequest,
  SpawnedSubprocess,
  SubprocessAdapter,
} from '@noetic-tools/types';

type CommandLauncher = (
  adapter: SubprocessAdapter,
  request: ProcessSubprocessRequest,
) => Promise<SpawnedSubprocess>;

/** The interpreter supplies the launcher for a document's command within its step. */
export const commandLaunchers = new WeakMap<
  Context,
  {
    spawn: CommandLauncher;
    canRetry(): boolean;
  }
>();
