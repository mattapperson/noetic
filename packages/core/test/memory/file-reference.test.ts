import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryLayer, RecallParams } from '@noetic-tools/memory';
import {
  createLayerStateStore,
  fileReference,
  initLayers,
  runAppendPipeline,
} from '@noetic-tools/memory';
import type { InputMessageItem, InputTextPart, Item } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

function callRecall(
  layer: MemoryLayer,
  params: RecallParams<unknown>,
): ReturnType<NonNullable<MemoryLayer['hooks']['recall']>> {
  return layer.hooks.recall!(params);
}

describe('fileReference', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ref-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
    });
  });

  function makeUserMessage(text: string): InputMessageItem {
    return {
      id: crypto.randomUUID(),
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    };
  }

  type TextOnlyInputMessage = Omit<InputMessageItem, 'content'> & {
    readonly content: InputTextPart[];
  };

  function isInputTextPart(value: unknown): value is InputTextPart {
    return (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'input_text' &&
      'text' in value &&
      typeof value.text === 'string'
    );
  }

  function isInputMessage(item: Item): item is TextOnlyInputMessage {
    return (
      item.type === 'message' &&
      'role' in item &&
      item.role === 'user' &&
      'content' in item &&
      Array.isArray(item.content) &&
      item.content.every(isInputTextPart)
    );
  }

  function assertInputMessage(item: Item): TextOnlyInputMessage {
    if (!isInputMessage(item)) {
      throw new Error(`Expected InputMessageItem but got ${item.type}`);
    }
    return item;
  }

  interface TestFileRefState {
    files: Map<string, unknown>;
    baseDir: string;
  }

  function getRecallContent(
    result:
      | {
          items: Item[];
          tokenCount: number;
        }
      | string
      | null,
  ): string {
    if (result === null || typeof result === 'string') {
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

  async function createTestFile(name: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
    });
    await fs.writeFile(filePath, content);
    return filePath;
  }

  it('transforms file references to anchor links', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('test.ts', 'console.log("hello");');

    const ctx = makeCtx({
      executionId: 'exec-anchor',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('Check out #test.ts please'),
    ];

    const result = await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(1);
    const transformed = assertInputMessage(result.items[0]);
    expect(transformed.content[0].text).toBe('Check out [#test.ts](#test-ts) please');
  });

  it('extracts multiple file references', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('a.ts', 'file a');
    await createTestFile('b.ts', 'file b');

    const ctx = makeCtx({
      executionId: 'exec-multi',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('Compare #a.ts and #b.ts'),
    ];

    const result = await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(1);
    const transformed = assertInputMessage(result.items[0]);
    expect(transformed.content[0].text).toContain('[#a.ts](#a-ts)');
    expect(transformed.content[0].text).toContain('[#b.ts](#b-ts)');
  });

  it('tracks files in state', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('tracked.ts', 'tracked content');

    const ctx = makeCtx({
      executionId: 'exec-state',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('Look at #tracked.ts'),
    ];

    await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    const state = store.get<{
      files: Map<string, unknown>;
    }>('exec-state', 'file-reference');
    expect(state?.files.size).toBe(1);
    expect(state?.files.has('tracked.ts')).toBe(true);
  });

  it('handles deleted files', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    const ctx = makeCtx({
      executionId: 'exec-deleted',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    // Reference a non-existent file
    const items: Item[] = [
      makeUserMessage('Check #nonexistent.ts'),
    ];

    await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    const state = store.get<{
      files: Map<
        string,
        {
          deleted: boolean;
        }
      >;
    }>('exec-deleted', 'file-reference');
    const fileInfo = state?.files.get('nonexistent.ts');
    expect(fileInfo?.deleted).toBe(true);
  });

  it('requests re-render when files change', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('changing.ts', 'original content');

    const ctx = makeCtx({
      executionId: 'exec-change',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    // First reference
    await runAppendPipeline({
      layers: [
        layer,
      ],
      items: [
        makeUserMessage('Check #changing.ts'),
      ],
      ctx,
      log: makeItemLog(),
      store,
    });

    // Modify the file
    await createTestFile('changing.ts', 'modified content');

    // Second message should detect change
    const result = await runAppendPipeline({
      layers: [
        layer,
      ],
      items: [
        makeUserMessage('What about now?'),
      ],
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.rerenderRequests.length).toBeGreaterThan(0);
    expect(result.rerenderRequests[0].timing).toBe('immediate');
  });

  it('handles paths with special characters', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('sub/dir/file.ts', 'nested file');

    const ctx = makeCtx({
      executionId: 'exec-nested',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('Check #sub/dir/file.ts'),
    ];

    const result = await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    const transformed = assertInputMessage(result.items[0]);
    expect(transformed.content[0].text).toBe('Check [#sub/dir/file.ts](#sub-dir-file-ts)');
  });

  it('deduplicates repeated references', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    await createTestFile('dup.ts', 'dup content');

    const ctx = makeCtx({
      executionId: 'exec-dup',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('#dup.ts and #dup.ts again'),
    ];

    await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    const state = store.get<{
      files: Map<string, unknown>;
    }>('exec-dup', 'file-reference');
    expect(state?.files.size).toBe(1);
  });

  it('passes through items without file references', async () => {
    const store = createLayerStateStore();
    const layer = fileReference({
      baseDir: tempDir,
    });

    const ctx = makeCtx({
      executionId: 'exec-passthrough',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const items: Item[] = [
      makeUserMessage('No file refs here'),
    ];

    const result = await runAppendPipeline({
      layers: [
        layer,
      ],
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(1);
    const passedThrough = assertInputMessage(result.items[0]);
    expect(passedThrough.content[0].text).toBe('No file refs here');
  });

  describe('recall()', () => {
    it('returns file contents ordered by priority', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      await createTestFile('low.ts', 'low priority file');
      await createTestFile('high.ts', 'high priority file');

      const ctx = makeCtx({
        executionId: 'exec-priority',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Reference both files
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #low.ts and #high.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      // Manually set priorities to test ordering
      type TrackedFileMap = Map<
        string,
        {
          priority: number;
        }
      >;
      const state = store.get<{
        files: TrackedFileMap;
        baseDir: string;
      }>('exec-priority', 'file-reference');
      if (state) {
        const lowFile = state.files.get('low.ts');
        const highFile = state.files.get('high.ts');
        if (lowFile) {
          lowFile.priority = 20;
        }
        if (highFile) {
          highFile.priority = 80;
        }
      }

      // Call recall - use getRecallContent helper for type safety
      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });

      const content = getRecallContent(recallResult);
      expect(content.length).toBeGreaterThan(0);
      // High priority file should appear before low priority
      const highIndex = content.indexOf('high.ts');
      const lowIndex = content.indexOf('low.ts');
      expect(highIndex).toBeLessThan(lowIndex);
    });

    it('shows error messages for files with errors', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
        allowedExtensions: [
          '.ts',
        ], // Only allow .ts
      });

      // Create a disallowed file
      await createTestFile('bad.exe', 'not allowed');

      const ctx = makeCtx({
        executionId: 'exec-errors',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Reference a file with disallowed extension
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #bad.exe'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<TestFileRefState>('exec-errors', 'file-reference');

      // Call recall
      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });

      const content = getRecallContent(recallResult);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('DISALLOWED_EXTENSION');
    });

    it('truncates content that exceeds budget', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      // Create a file with many lines
      const manyLines = Array.from(
        {
          length: 100,
        },
        (_, i) => `Line ${i + 1}: Some content here`,
      ).join('\n');
      await createTestFile('large.ts', manyLines);

      const ctx = makeCtx({
        executionId: 'exec-truncate',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #large.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<TestFileRefState>('exec-truncate', 'file-reference');

      // Call recall with very small budget
      const recallResult = await callRecall(layer, {
        state,
        budget: 100, // Very small budget
        query: '',
        ctx,
        log: makeItemLog(),
      });

      // With such a small budget, either no items or truncated
      const content = getRecallContent(recallResult);
      if (content.length > 0) {
        expect(content).toContain('truncated');
      }
    });

    it('shows deleted file message', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      await createTestFile('willdelete.ts', 'temporary content');

      const ctx = makeCtx({
        executionId: 'exec-del-recall',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Reference the file
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #willdelete.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      // Delete the file
      await fs.unlink(path.join(tempDir, 'willdelete.ts'));

      // Run pipeline again to detect deletion
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Any update?'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<TestFileRefState>('exec-del-recall', 'file-reference');

      // Call recall
      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });

      const content = getRecallContent(recallResult);
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('FILE DELETED');
    });

    it('returns empty for no files', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      const ctx = makeCtx({
        executionId: 'exec-empty',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      const state = store.get<TestFileRefState>('exec-empty', 'file-reference');

      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });

      const content = getRecallContent(recallResult);
      expect(content).toBe('');
    });
  });

  describe('security', () => {
    it('pattern does not match absolute paths', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      const ctx = makeCtx({
        executionId: 'exec-abs',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Absolute paths like #/tmp/secret.txt should not match the pattern
      // The pattern only matches relative paths with extensions
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #/tmp/secret.txt'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<string, unknown>;
      }>('exec-abs', 'file-reference');
      // Pattern doesn't match absolute paths at all
      expect(state?.files.size).toBe(0);
    });

    it('rejects path traversal attempts', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      // Create file in temp dir
      await createTestFile('legit.ts', 'legitimate file');

      const ctx = makeCtx({
        executionId: 'exec-traversal',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Try to read file outside baseDir via path traversal
      // Use a path that looks like a valid file (has extension) but traverses
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #../outside.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<
          string,
          {
            error?: string;
          }
        >;
      }>('exec-traversal', 'file-reference');
      const fileInfo = state?.files.get('../outside.ts');
      expect(fileInfo?.error).toContain('PATH_TRAVERSAL');
    });

    it('rejects disallowed file extensions', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
        allowedExtensions: [
          '.ts',
          '.js',
        ],
      });

      await createTestFile('secret.exe', 'evil binary');

      const ctx = makeCtx({
        executionId: 'exec-ext',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #secret.exe'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<
          string,
          {
            error?: string;
          }
        >;
      }>('exec-ext', 'file-reference');
      const fileInfo = state?.files.get('secret.exe');
      expect(fileInfo?.error).toContain('DISALLOWED_EXTENSION');
    });

    it('rejects files exceeding size limit', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
        maxFileSize: 100, // 100 bytes
      });

      // Create a file larger than limit
      await createTestFile('large.ts', 'x'.repeat(200));

      const ctx = makeCtx({
        executionId: 'exec-size',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Check #large.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<
          string,
          {
            error?: string;
          }
        >;
      }>('exec-size', 'file-reference');
      const fileInfo = state?.files.get('large.ts');
      expect(fileInfo?.error).toContain('FILE_TOO_LARGE');
    });
  });

  describe('symlinked path component rejection (M9)', () => {
    interface TrackedFileProbe {
      content: string | null;
      error?: string;
    }

    interface PipelineRunResult {
      layer: MemoryLayer;
      ctx: ReturnType<typeof makeCtx>;
      state:
        | {
            files: Map<string, TrackedFileProbe>;
          }
        | undefined;
    }

    async function runFileRefPipeline(args: {
      executionId: string;
      baseDir: string;
      message: string;
      followSymlinks?: boolean;
    }): Promise<PipelineRunResult> {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: args.baseDir,
        followSymlinks: args.followSymlinks,
      });
      const ctx = makeCtx({
        executionId: args.executionId,
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage(args.message),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });
      const state = store.get<{
        files: Map<string, TrackedFileProbe>;
      }>(args.executionId, 'file-reference');
      return {
        layer,
        ctx,
        state,
      };
    }

    /** Creates base/ and outside/ dirs with outside/secret.ts + base/link → outside. */
    async function createSymlinkedDirEscape(): Promise<{
      baseDir: string;
      outsideContent: string;
    }> {
      const baseDir = path.join(tempDir, 'base');
      const outsideDir = path.join(tempDir, 'outside');
      const outsideContent = 'TOP_SECRET_OUTSIDE_CONTENT';
      await fs.mkdir(baseDir, {
        recursive: true,
      });
      await fs.mkdir(outsideDir, {
        recursive: true,
      });
      await fs.writeFile(path.join(outsideDir, 'secret.ts'), outsideContent);
      await fs.symlink(outsideDir, path.join(baseDir, 'link'));
      return {
        baseDir,
        outsideContent,
      };
    }

    it('rejects a symlinked directory inside baseDir pointing outside; recall never injects the outside content', async () => {
      const { baseDir, outsideContent } = await createSymlinkedDirEscape();

      const { layer, ctx, state } = await runFileRefPipeline({
        executionId: 'exec-symdir',
        baseDir,
        message: 'Check #link/secret.ts',
      });

      const tracked = state?.files.get('link/secret.ts');
      expect(tracked?.error).toContain('SYMLINK: Symlinks not allowed');
      expect(tracked?.content).toBeNull();

      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });
      const content = getRecallContent(recallResult);
      expect(content).toContain('SYMLINK: Symlinks not allowed');
      expect(content).not.toContain(outsideContent);
    });

    it('still rejects a symlink at the leaf (regression)', async () => {
      const baseDir = path.join(tempDir, 'base');
      const outsideDir = path.join(tempDir, 'outside');
      await fs.mkdir(baseDir, {
        recursive: true,
      });
      await fs.mkdir(outsideDir, {
        recursive: true,
      });
      await fs.writeFile(path.join(outsideDir, 'real.ts'), 'outside leaf content');
      await fs.symlink(path.join(outsideDir, 'real.ts'), path.join(baseDir, 'link.ts'));

      const { state } = await runFileRefPipeline({
        executionId: 'exec-symleaf',
        baseDir,
        message: 'Check #link.ts',
      });

      const tracked = state?.files.get('link.ts');
      expect(tracked?.error).toContain('SYMLINK: Symlinks not allowed');
      expect(tracked?.content).toBeNull();
    });

    it('followSymlinks: true reads through symlinked directories', async () => {
      const { baseDir, outsideContent } = await createSymlinkedDirEscape();

      const { layer, ctx, state } = await runFileRefPipeline({
        executionId: 'exec-symfollow',
        baseDir,
        message: 'Check #link/secret.ts',
        followSymlinks: true,
      });

      const tracked = state?.files.get('link/secret.ts');
      expect(tracked?.error).toBeUndefined();
      expect(tracked?.content).toBe(outsideContent);

      const recallResult = await callRecall(layer, {
        state,
        budget: 10000,
        query: '',
        ctx,
        log: makeItemLog(),
      });
      expect(getRecallContent(recallResult)).toContain(outsideContent);
    });

    it('detects a symlinked component at depth 3 of a 4-deep path', async () => {
      const baseDir = path.join(tempDir, 'base');
      const outsideDir = path.join(tempDir, 'outside');
      await fs.mkdir(path.join(baseDir, 'a/b'), {
        recursive: true,
      });
      await fs.mkdir(outsideDir, {
        recursive: true,
      });
      await fs.writeFile(path.join(outsideDir, 'd.ts'), 'deep outside content');
      await fs.symlink(outsideDir, path.join(baseDir, 'a/b/c'));

      const { state } = await runFileRefPipeline({
        executionId: 'exec-symdeep',
        baseDir,
        message: 'Check #a/b/c/d.ts',
      });

      const tracked = state?.files.get('a/b/c/d.ts');
      expect(tracked?.error).toContain('SYMLINK: Symlinks not allowed');
      expect(tracked?.content).toBeNull();
    });

    it('reads a clean deep path with no symlink components', async () => {
      const baseDir = path.join(tempDir, 'base');
      await fs.mkdir(path.join(baseDir, 'a/b/c'), {
        recursive: true,
      });
      await fs.writeFile(path.join(baseDir, 'a/b/c/d.ts'), 'clean deep content');

      const { state } = await runFileRefPipeline({
        executionId: 'exec-cleandeep',
        baseDir,
        message: 'Check #a/b/c/d.ts',
      });

      const tracked = state?.files.get('a/b/c/d.ts');
      expect(tracked?.error).toBeUndefined();
      expect(tracked?.content).toBe('clean deep content');
    });

    it('works with a /tmp baseDir (base and its ancestors are never symlink-checked)', async () => {
      // macOS: /tmp itself is a symlink to /private/tmp. Components AT or
      // ABOVE baseDir must never be lstat-checked or every read under /tmp
      // would be rejected.
      const baseDir = await fs.mkdtemp('/tmp/file-ref-m9-');
      try {
        await fs.mkdir(path.join(baseDir, 'sub'), {
          recursive: true,
        });
        await fs.writeFile(path.join(baseDir, 'sub/ok.ts'), 'tmp ok');

        const { state } = await runFileRefPipeline({
          executionId: 'exec-tmpbase',
          baseDir,
          message: 'Check #sub/ok.ts',
        });

        const tracked = state?.files.get('sub/ok.ts');
        expect(tracked?.error).toBeUndefined();
        expect(tracked?.content).toBe('tmp ok');
      } finally {
        await fs.rm(baseDir, {
          recursive: true,
          force: true,
        });
      }
    });
  });

  describe('pattern matching', () => {
    it('ignores hashtags without file extensions', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      const ctx = makeCtx({
        executionId: 'exec-hashtag',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // These should NOT be matched as file references
      const items: Item[] = [
        makeUserMessage('Check #hashtag and #123 and #region'),
      ];

      const result = await runAppendPipeline({
        layers: [
          layer,
        ],
        items,
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<string, unknown>;
      }>('exec-hashtag', 'file-reference');
      // No files should be tracked
      expect(state?.files.size).toBe(0);
      // Text should pass through unchanged
      const transformed = assertInputMessage(result.items[0]);
      expect(transformed.content[0].text).toBe('Check #hashtag and #123 and #region');
    });

    it('matches files with extensions', async () => {
      const store = createLayerStateStore();
      const layer = fileReference({
        baseDir: tempDir,
      });

      await createTestFile('real.ts', 'actual file');
      await createTestFile('also/nested.js', 'nested file');

      const ctx = makeCtx({
        executionId: 'exec-match',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      const items: Item[] = [
        makeUserMessage('Check #real.ts and #also/nested.js'),
      ];

      await runAppendPipeline({
        layers: [
          layer,
        ],
        items,
        ctx,
        log: makeItemLog(),
        store,
      });

      const state = store.get<{
        files: Map<string, unknown>;
      }>('exec-match', 'file-reference');
      expect(state?.files.size).toBe(2);
      expect(state?.files.has('real.ts')).toBe(true);
      expect(state?.files.has('also/nested.js')).toBe(true);
    });
  });

  describe('append-pipeline timeout headroom + parallel scoring (M8)', () => {
    it('factory pins onItemAppend timeout at 30s (fs + LLM work cannot fit the 5s default)', () => {
      const layer = fileReference();
      expect(layer.timeouts?.onItemAppend).toBe(30_000);
    });

    it('scores multiple new references in parallel (wall time ≪ sequential), all tracked', async () => {
      const DELAY_MS = 200;
      await createTestFile('p1.ts', 'one');
      await createTestFile('p2.ts', 'two');
      await createTestFile('p3.ts', 'three');

      const layer = fileReference({
        baseDir: tempDir,
      });
      const store = createLayerStateStore();
      const ctx = makeCtx({
        executionId: 'exec-parallel',
        callModel: async () => {
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          return {
            items: [
              {
                id: crypto.randomUUID(),
                status: 'completed',
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: '75',
                  },
                ],
              },
            ],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
            },
          };
        },
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      const started = performance.now();
      await runAppendPipeline({
        layers: [
          layer,
        ],
        items: [
          makeUserMessage('Look at #p1.ts #p2.ts #p3.ts'),
        ],
        ctx,
        log: makeItemLog(),
        store,
      });
      const elapsed = performance.now() - started;

      const state = store.get<{
        files: Map<
          string,
          {
            priority: number;
          }
        >;
      }>('exec-parallel', 'file-reference');
      expect(state?.files.size).toBe(3);
      for (const ref of [
        'p1.ts',
        'p2.ts',
        'p3.ts',
      ]) {
        expect(state?.files.get(ref)?.priority).toBe(75);
      }
      // Three sequential 200ms scoring calls would take ≥ 600ms; parallel
      // execution stays well under 2× a single call.
      expect(elapsed).toBeLessThan(DELAY_MS * 2);
    });
  });
});
