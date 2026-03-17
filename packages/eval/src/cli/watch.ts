import * as fs from 'node:fs';
import * as path from 'node:path';

//#region Types

interface Closeable {
  close(): void;
}

//#endregion

//#region Constants

const DEBOUNCE_MS = 3e2;

//#endregion

//#region Public API

export function watchFiles(files: string[], onChange: () => void): Closeable {
  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleChange = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const filesByDir = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = path.dirname(file);
    const existing = filesByDir.get(dir) ?? new Set<string>();
    existing.add(path.basename(file));
    filesByDir.set(dir, existing);
  }

  for (const [dir, filenames] of filesByDir) {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filenames.has(filename)) {
        handleChange();
      }
    });
    watchers.push(watcher);
  }

  return {
    close(): void {
      for (const w of watchers) {
        w.close();
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  };
}

//#endregion
