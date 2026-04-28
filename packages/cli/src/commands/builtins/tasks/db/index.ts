import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import { createDataDir } from '../../../../plugins/data-dir.js';
import * as schema from './schema.js';

export interface TasksDatabase {
  db: BunSQLiteDatabase<typeof schema>;
  sqlite: Database;
  path: string;
  close: () => void;
}

const DB_FILE_NAME = 'tasks.sqlite';
const MIGRATIONS_DIR = fileURLToPath(new URL('migrations', import.meta.url));

export function getTasksDatabasePath(cwd: string): string {
  const dataDir = createDataDir(cwd, 'tasks')('user');
  return join(dataDir, DB_FILE_NAME);
}

export function openTasksDatabase(cwd: string): TasksDatabase {
  return openTasksDatabaseAtPath(getTasksDatabasePath(cwd));
}

export function openTasksDatabaseAtPath(path: string): TasksDatabase {
  mkdirSync(dirname(path), {
    recursive: true,
  });
  const sqlite = new Database(path, {
    create: true,
  });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA journal_mode = WAL;');
  normalizeBogusMigrationTimestamps(sqlite);
  const db = drizzle(sqlite, {
    schema,
  });
  migrate(db, {
    migrationsFolder: MIGRATIONS_DIR,
  });
  return {
    db,
    sqlite,
    path,
    close: () => sqlite.close(),
  };
}

const BOGUS_TIMESTAMP_REWRITES: ReadonlyArray<
  readonly [
    bogus: number,
    sane: number,
  ]
> = [
  [
    1777948363000,
    1777314700000,
  ],
  [
    1777948363001,
    1777325435941,
  ],
];

function normalizeBogusMigrationTimestamps(sqlite: Database): void {
  const tableExists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!tableExists) {
    return;
  }
  const update = sqlite.prepare(
    'UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?',
  );
  for (const [bogus, sane] of BOGUS_TIMESTAMP_REWRITES) {
    update.run(sane, bogus);
  }
}
