import type {
  AdapterSets,
  Context,
  ContextCacheStore,
  ContextWindow,
  FsAdapter,
  ItemSchemaRegistry,
  LayerWindow,
  ShellAdapter,
  StorageAdapter,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ItemLogImpl } from '../runtime/item-log-impl';
import { layerWindow } from './context-stream';
import type { LayerStateStore } from './deps/context';
import {
  contextToExecCtx,
  createLayerStateStore,
  DEFAULT_PROJECTION,
  initLayers,
  lineageKey,
  projectHistoryLayers,
  recallLayers,
} from './deps/context';
import { assembleModelItems, computeBudgetMap, prepareBandedView } from './deps/interpreter';

/** Render a window in scratch state without changing the live turn or its cache. */
export async function previewContext({
  ctx,
  liveState,
  cache,
  schemas,
  storage,
}: {
  ctx: Context;
  liveState?: LayerStateStore;
  cache: ContextCacheStore;
  schemas: ItemSchemaRegistry;
  storage?: StorageAdapter;
}): Promise<ContextWindow> {
  const config = ctx.harness.config;
  const layers = ctx.layers ?? [];
  const seen = new Map<string, LayerWindow>();
  const byId = new Map(
    layers.map((layer) => [
      layer.id,
      layer,
    ]),
  );
  const store = createLayerStateStore((id, hook) => {
    const layer = byId.get(id);
    if (hook === 'init' && layer) {
      seen.set(
        id,
        layerWindow({
          layer,
          source: 'fresh',
          outcome: 'failed',
        }),
      );
    }
  });
  const exec = {
    ...contextToExecCtx(ctx),
    approve: undefined,
    fs: readOnlyFs(ctx.harness.fs),
    shell: readOnlyShell,
    adapters: readOnlyAdapters(ctx.harness.adapters),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(id: string): T | undefined => structuredClone(store.get<T>(ctx.id, id)),
  };
  const log = new ItemLogImpl(schemas);
  log.replace(structuredClone(ctx.itemLog.items));
  if (liveState) {
    for (const layer of layers) {
      if (liveState.isDisabled?.(ctx.id, layer.id)) {
        store.disable?.(ctx.id, layer.id);
        continue;
      }
      const state = liveState.get(ctx.id, layer.id);
      if (state === undefined && !liveState.has?.(ctx.id, layer.id)) {
        continue;
      }
      try {
        store.set(ctx.id, layer.id, structuredClone(state));
      } catch {
        store.disable?.(ctx.id, layer.id);
        seen.set(
          layer.id,
          layerWindow({
            layer,
            source: 'fresh',
            outcome: 'unpeekable',
          }),
        );
      }
    }
  } else {
    await initLayers({
      layers: layers.map((layer) => ({
        ...layer,
        onInitError: 'disable',
      })),
      ctx: exec,
      storage: previewStorage(storage),
      store,
      readOnly: true,
    });
  }

  const policy = config.projection ?? DEFAULT_PROJECTION;
  const budgets = computeBudgetMap({
    layers,
    policy,
    systemPromptTokens: 0,
  });
  const recall = await recallLayers({
    layers,
    query: '',
    ctx: exec,
    log,
    budgets,
    store,
    itemSchemas: schemas,
    peek: true,
    observe: (event) => {
      if (event.outcome !== 'running' && !seen.has(event.layer.id)) {
        seen.set(event.layer.id, layerWindow(event));
      }
    },
  });
  const history = await projectHistoryLayers({
    layers,
    items: log.items,
    ctx: exec,
    store,
  });
  const view = await prepareBandedView({
    recallResults: recall,
    layers,
    execCtx: exec,
    store: previewCache(cache, lineageKey(exec)),
    config: config.contextCache,
    instructions: undefined,
    policy,
    systemPromptItems: [],
    budgets,
    readOnly: true,
  });
  return structuredClone({
    threadId: ctx.threadId,
    executionId: liveState ? ctx.id : undefined,
    status: 'preview',
    layers: [
      ...seen.values(),
    ],
    items:
      layers.length === 0
        ? history
        : assembleModelItems({
            history,
            banded: view,
            policy,
          }),
  });
}

function previewCache(cache: ContextCacheStore, key: string): ContextCacheStore {
  const epochs: ContextCacheStore['epochs'] = new Map();
  const epoch = cache.epochs.get(key);
  if (epoch) {
    try {
      epochs.set(key, structuredClone(epoch));
    } catch {
      // A custom pin can carry opaque state. Render a fresh view instead.
    }
  }
  return {
    epochs,
    churn: new Map(cache.churn),
    pendingReanchor: new Map(),
  };
}

/** Let init hooks read durable state and stage scratch writes without reaching the backing store. */
function previewStorage(storage?: StorageAdapter): StorageAdapter {
  const writes = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      if (writes.has(key)) {
        return frameworkCast<T | null>(structuredClone(writes.get(key)));
      }
      return structuredClone((await storage?.get<T>(key)) ?? null);
    },
    async set<T>(key: string, value: T) {
      writes.set(key, structuredClone(value));
    },
    async delete(key: string) {
      writes.set(key, null);
    },
    async list(prefix: string) {
      const keys = new Set(await storage?.list(prefix));
      for (const [key, value] of writes) {
        if (key.startsWith(prefix)) {
          if (value === null) {
            keys.delete(key);
          } else {
            keys.add(key);
          }
        }
      }
      return [
        ...keys,
      ];
    },
  };
}

function readOnly(): Promise<never> {
  return Promise.reject(
    new Error('Context previews cannot write files, run shell commands or start processes.'),
  );
}

const readOnlyShell: ShellAdapter = {
  exec: readOnly,
};

/** Every named adapter behind the same guard as the defaults, so a preview has no way around it. */
function readOnlyAdapters(adapters: AdapterSets): AdapterSets {
  return {
    fs: {
      get: (name) => readOnlyFs(adapters.fs.get(name)),
      list: () => adapters.fs.list(),
    },
    shell: {
      get: (name) => {
        adapters.shell.get(name);
        return readOnlyShell;
      },
      list: () => adapters.shell.list(),
    },
    subprocess: {
      get: (name) => readOnlySubprocess(adapters.subprocess.get(name)),
      list: () => adapters.subprocess.list(),
    },
  };
}

/** Looks at what runs; starts, stops and reattaches nothing. */
function readOnlySubprocess(subprocess: SubprocessAdapter): SubprocessAdapter {
  return {
    get: subprocess.get.bind(subprocess),
    isAlive: subprocess.isAlive.bind(subprocess),
    listLive: subprocess.listLive.bind(subprocess),
    spawn: readOnly,
    stop: readOnly,
    pause: readOnly,
    resume: readOnly,
    // The in-memory adapter reattaches by running the step again.
    reattach: readOnly,
  };
}

function readOnlyFs(fs: FsAdapter): FsAdapter {
  return {
    readFile: fs.readFile.bind(fs),
    readFileText: fs.readFileText.bind(fs),
    access: fs.access.bind(fs),
    stat: fs.stat.bind(fs),
    lstat: fs.lstat.bind(fs),
    readdir: fs.readdir.bind(fs),
    writeFile: readOnly,
    writeFileBytes: readOnly,
    appendFile: readOnly,
    mkdir: readOnly,
    rename: readOnly,
    rm: readOnly,
  };
}
