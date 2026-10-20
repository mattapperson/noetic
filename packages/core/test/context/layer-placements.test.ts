import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import {
  filesystem,
  instructions,
  observations,
  scratchpad,
  steering,
  temporal,
} from '@noetic-tools/context';
import type { Item } from '@noetic-tools/types';
import { createMessage } from '@noetic-tools/types';
import { makeCtx } from '../_helpers';

function referencedFiles(blocks: string[]): Item[] {
  return [
    createMessage(`# Referenced Files\n\n${blocks.join('\n\n')}`, 'developer'),
  ];
}

function fileBlock(path: string, body: string): string {
  return `## ${path}\n\n\`\`\`\n${body}\n\`\`\``;
}

describe('built-in layer placements', () => {
  // Its recall drains the pending queue as it renders, so a pin would replay a
  // render whose feedback was already consumed.
  it('renders steering live', () => {
    expect(
      steering({
        rules: [],
      }).placement,
    ).toBe('live');
  });

  // The `<current_datetime>` block changes every turn by construction.
  it('renders temporal live while it grounds the clock', () => {
    expect(temporal().placement).toBe('live');
  });

  it('lets temporal anchor when it only carries the fact ledger', () => {
    expect(
      temporal({
        groundDateTime: false,
        injectLedger: true,
      }).placement,
    ).toBe('auto');
  });

  it('anchors static content, which never changes after init', () => {
    expect(
      instructions({
        load: async () => 'body',
      }).placement,
    ).toBe('anchor');
  });

  it('anchors file references', () => {
    expect(filesystem().placement).toBe('anchor');
  });

  // Layers whose churn depends entirely on the workload declare nothing and let
  // the runtime decide from what it observes.
  it('leaves a workload-dependent layer undeclared', () => {
    const workload: ContextLayer[] = [
      scratchpad(),
      observations(),
    ];

    for (const layer of workload) {
      expect(layer.placement).toBeUndefined();
    }
  });
});

describe('filesystem renderDelta', () => {
  const hook = filesystem().hooks.renderDelta;

  async function render(prev: Item[], next: Item[]): Promise<string | null> {
    assert(hook !== undefined);
    return hook({
      prev,
      next,
      prevState: undefined,
      state: undefined,
      ctx: makeCtx(),
      budget: 4_000,
    });
  }

  it('reports only the file that changed', async () => {
    const result = await render(
      referencedFiles([
        fileBlock('a.ts', 'old-a'),
        fileBlock('b.ts', 'same-b'),
      ]),
      referencedFiles([
        fileBlock('a.ts', 'new-a'),
        fileBlock('b.ts', 'same-b'),
      ]),
    );

    assert(result !== null);
    expect(result).toContain('new-a');
    expect(result).not.toContain('same-b');
  });

  it('names files that are no longer referenced', async () => {
    const result = await render(
      referencedFiles([
        fileBlock('a.ts', 'body-a'),
        fileBlock('gone.ts', 'body-gone'),
      ]),
      referencedFiles([
        fileBlock('a.ts', 'body-a'),
      ]),
    );

    assert(result !== null);
    expect(result).toContain('No longer referenced: gone.ts');
    expect(result).not.toContain('body-a');
  });

  it('includes a newly referenced file in full', async () => {
    const result = await render(
      referencedFiles([
        fileBlock('a.ts', 'body-a'),
      ]),
      referencedFiles([
        fileBlock('a.ts', 'body-a'),
        fileBlock('new.ts', 'body-new'),
      ]),
    );

    assert(result !== null);
    expect(result).toContain('body-new');
    expect(result).not.toContain('body-a');
  });

  // Returning null hands the decision back to the runtime, which republishes in
  // full rather than publishing an empty supersede.
  it('declines when nothing actually differs', async () => {
    const same = referencedFiles([
      fileBlock('a.ts', 'body-a'),
    ]);

    expect(await render(same, same)).toBeNull();
  });

  it('is far smaller than republishing a large stable set', async () => {
    const stable = Array.from(
      {
        length: 12,
      },
      (_, i) => fileBlock(`file-${i}.ts`, 'x'.repeat(2_000)),
    );
    const next = [
      ...stable,
    ];
    next[0] = fileBlock('file-0.ts', 'y'.repeat(2_000));

    const result = await render(referencedFiles(stable), referencedFiles(next));
    const fullRepublish = JSON.stringify(referencedFiles(next)).length;

    assert(result !== null);
    expect(result.length).toBeLessThan(fullRepublish / 5);
  });
});
