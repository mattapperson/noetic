import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Per-test-process NOETIC_HOME so real-fs tests that spawn planner /
// implementer runners (or otherwise hit the task store) land in a
// clean tempdir instead of polluting the developer's `~/.noetic/tasks`.
// Individual tests that want to pin a specific `tasksRoot` still can
// — this only changes the env default.
//
// We build the override under `/tmp` (not `os.tmpdir()`) because
// `os.tmpdir()` on macOS resolves to
// `/var/folders/<disambig>/T/…` which, combined with `<taskId>/sockets/
// planner.sock`, overflows the 104-byte `sun_path` cap for task-chat
// sockets. `/tmp/noetic-test-home-XXXX/tasks/T-xxx/sockets/planner.sock`
// stays under the limit on every supported platform.
const noeticHomeOverride = mkdtempSync(join('/tmp', 'noetic-test-home-'));

beforeAll(() => {
  process.env.NOETIC_HOME = noeticHomeOverride;
});

beforeEach(() => {
  process.env.OPENROUTER_API_KEY ??= 'test-key';
});

afterAll(() => {
  try {
    rmSync(noeticHomeOverride, {
      recursive: true,
      force: true,
    });
  } catch {
    /* swallow — best-effort cleanup */
  }
});
