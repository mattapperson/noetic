import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonRuntimePaths {
  dir: string;
  lockPath: string;
  pidPath: string;
  socketPath: string;
}

const DAEMON_DIR = join(homedir(), '.noetic', 'daemon');

export function daemonRuntimePaths(): DaemonRuntimePaths {
  return {
    dir: DAEMON_DIR,
    lockPath: join(DAEMON_DIR, 'daemon.lock'),
    pidPath: join(DAEMON_DIR, 'daemon.pid'),
    socketPath: join(DAEMON_DIR, 'daemon.sock'),
  };
}
