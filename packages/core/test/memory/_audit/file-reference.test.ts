import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLayerStateStore,
  fileReference,
  initLayers,
  runAppendPipeline,
} from '@noetic-tools/memory';
import type { Item, MemoryLayer, RecallParams } from '@noetic-tools/types';
import { estimateTokens } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeMessage, makeStorage } from '../../_helpers';

//#region Local helpers (mirrors file-reference.test.ts)

function callRecall(
  layer: MemoryLayer,
  params: RecallParams<unknown>,
): ReturnType<NonNullable<MemoryLayer['hooks']['recall']>> {
  return layer.hooks.recall!(params);
}

interface RecallObject {
  items: Item[];
  tokenCount: number;
}

function isRecallObject(result: RecallObject | string | null): result is RecallObject {
  return result !== null && typeof result !== 'string';
}

interface TrackedFileView {
  content: string | null;
  error?: string;
}

interface FileRefStateView {
  files: Map<string, TrackedFileView>;
}

function getRecallContent(result: RecallObject | string | null): string {
  if (!isRecallObject(result)) {
    return result ?? '';
  }
  if (result.items.length === 0) {
    return '';
  }
  const item = result.items[0];
  if (item.type !== 'message' || !('content' in item)) {
    return '';
  }
  const content = item.content;
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const first = content[0];
  if ('text' in first && typeof first.text === 'string') {
    return first.text;
  }
  return '';
}

//#endregion

describe('fileReference AUDIT', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ref-audit-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
    });
  });

  async function createTestFile(name: string, content: string): Promise<void> {
    const filePath = path.join(tempDir, name);
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
    });
    await fs.writeFile(filePath, content);
  }

  async function appendMessage(args: {
    layer: MemoryLayer;
    store: ReturnType<typeof createLayerStateStore>;
    ctx: ReturnType<typeof makeCtx>;
    text: string;
  }): Promise<void> {
    await runAppendPipeline({
      layers: [
        args.layer,
      ],
      items: [
        makeMessage('user', args.text),
      ],
      ctx: args.ctx,
      log: makeItemLog(),
      store: args.store,
    });
  }

  // ── Bug A: recall emits MORE tokens than the budget ───────────────────
  // The truncation keeps ~90% of LINES regardless of the token budget, so a
  // file with few-but-long lines blows the budget wide open. recall must
  // self-limit to `budget` (it is the canonical budget-respecting layer).
  it('AUDIT-A: recall tokenCount must not exceed the supplied budget', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    // 5 lines × 400 chars ≈ 2000 chars ≈ 500 tokens of content.
    const longLine = 'a'.repeat(400);
    const fileContent = Array.from(
      {
        length: 5,
      },
      () => longLine,
    ).join('\n');
    await createTestFile('big.ts', fileContent);

    const ctx = makeCtx({
      executionId: 'exec-budget',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    await appendMessage({
      layer,
      store,
      ctx,
      text: 'Check #big.ts',
    });

    const state = store.get<FileRefStateView>('exec-budget', 'file-reference');

    const BUDGET = 80;
    const recallResult = await callRecall(layer, {
      state,
      budget: BUDGET,
      query: '',
      ctx,
      log: makeItemLog(),
    });

    expect(isRecallObject(recallResult)).toBe(true);
    if (!isRecallObject(recallResult)) {
      return;
    }
    // The honest emitted size must fit the budget.
    expect(recallResult.tokenCount).toBeLessThanOrEqual(BUDGET);
    // Sanity: the rendered content itself must also fit.
    const content = getRecallContent(recallResult);
    expect(estimateTokens(content)).toBeLessThanOrEqual(BUDGET);
  });

  // ── Bug B: line-based truncation ignores the token budget ─────────────
  // Independent of the wrapper: even the single truncated block of one file
  // exceeds the remaining budget because head(60%)+tail(30%) keeps 90% of a
  // huge file.
  it('AUDIT-B: a single oversized file truncated for budget must shrink to roughly the budget', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    // 200 short lines ≈ 200 * 21 ≈ 4200 chars ≈ 1050 tokens.
    const fileContent = Array.from(
      {
        length: 200,
      },
      (_unused, i) => `line number ${i}`,
    ).join('\n');
    await createTestFile('many.ts', fileContent);

    const ctx = makeCtx({
      executionId: 'exec-trunc',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    await appendMessage({
      layer,
      store,
      ctx,
      text: 'Check #many.ts',
    });

    const state = store.get<FileRefStateView>('exec-trunc', 'file-reference');

    const BUDGET = 100;
    const recallResult = await callRecall(layer, {
      state,
      budget: BUDGET,
      query: '',
      ctx,
      log: makeItemLog(),
    });

    expect(isRecallObject(recallResult)).toBe(true);
    if (!isRecallObject(recallResult)) {
      return;
    }
    // Allow some slack for the markdown wrapper, but it must be in the
    // ballpark of the budget — not ~10x over it.
    expect(recallResult.tokenCount).toBeLessThanOrEqual(BUDGET * 2);
  });

  // ── Bug C: dedup keyed by raw ref string, not resolved path ───────────
  // `#config.json` and `#./config.json` resolve to the SAME file but get
  // tracked (and rendered) twice, double-counting tokens.
  it('AUDIT-C: two references resolving to the same file must dedupe to one entry', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('config.json', '{"a":1}');

    const ctx = makeCtx({
      executionId: 'exec-dedup',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    await appendMessage({
      layer,
      store,
      ctx,
      text: 'See #config.json and #./config.json',
    });

    const state = store.get<FileRefStateView>('exec-dedup', 'file-reference');
    expect(state?.files.size).toBe(1);
  });

  // ── Bug D: an errored file is never re-read after the error clears ─────
  // refreshTrackedFile() bails out with `return null` whenever the tracked
  // file has an `error`, permanently freezing it even after the underlying
  // condition (too large / permission) is fixed.
  it('AUDIT-D: a file that errored then became valid must recover its content', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
      maxFileSize: 50,
    });

    // First: too large → tracked with FILE_TOO_LARGE error.
    await createTestFile('data.ts', 'x'.repeat(200));

    const ctx = makeCtx({
      executionId: 'exec-recover',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    await appendMessage({
      layer,
      store,
      ctx,
      text: 'Check #data.ts',
    });

    const errored = store
      .get<FileRefStateView>('exec-recover', 'file-reference')
      ?.files.get('data.ts');
    expect(errored?.error).toContain('FILE_TOO_LARGE');

    // Now shrink the file so it is readable.
    await createTestFile('data.ts', 'ok');

    // A subsequent message should pick up the now-valid file.
    await appendMessage({
      layer,
      store,
      ctx,
      text: 'Check #data.ts again',
    });

    const recovered = store
      .get<FileRefStateView>('exec-recover', 'file-reference')
      ?.files.get('data.ts');
    expect(recovered?.error).toBeUndefined();
    expect(recovered?.content).toBe('ok');
  });
});
