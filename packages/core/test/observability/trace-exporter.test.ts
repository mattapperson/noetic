import { describe, it, expect } from 'bun:test';
import { NoopExporter, InMemoryExporter } from '../../src/observability/trace-exporter';
import { SpanImpl } from '../../src/observability/span-impl';

describe('NoopExporter', () => {
  it('export resolves without error', async () => {
    const exporter = new NoopExporter();
    const result = await exporter.export([new SpanImpl('test', null)]);
    expect(result).toBeUndefined();
  });

  it('has no spans property', () => {
    const exporter = new NoopExporter();
    expect((exporter as any).spans).toBeUndefined();
  });
});

describe('InMemoryExporter', () => {
  it('collects spans', async () => {
    const exporter = new InMemoryExporter();
    const span = new SpanImpl('test', null);
    await exporter.export([span]);
    expect(exporter.spans).toHaveLength(1);
  });

  it('getSpansByName filters', async () => {
    const exporter = new InMemoryExporter();
    await exporter.export([new SpanImpl('a', null), new SpanImpl('b', null), new SpanImpl('a', null)]);
    expect(exporter.getSpansByName('a')).toHaveLength(2);
    expect(exporter.getSpansByName('b')).toHaveLength(1);
  });

  it('getChildSpans finds children', async () => {
    const exporter = new InMemoryExporter();
    const parent = new SpanImpl('parent', null);
    const child1 = new SpanImpl('child1', parent);
    const child2 = new SpanImpl('child2', parent);
    const unrelated = new SpanImpl('other', null);
    await exporter.export([parent, child1, child2, unrelated]);
    expect(exporter.getChildSpans(parent.spanId)).toHaveLength(2);
  });

  it('getTraceTree returns all spans in trace', async () => {
    const exporter = new InMemoryExporter();
    const root = new SpanImpl('root', null);
    const child = new SpanImpl('child', root);
    const other = new SpanImpl('other', null);
    await exporter.export([root, child, other]);
    expect(exporter.getTraceTree(root.traceId)).toHaveLength(2);
  });

  it('clear removes all spans', async () => {
    const exporter = new InMemoryExporter();
    await exporter.export([new SpanImpl('test', null)]);
    expect(exporter.spans).toHaveLength(1);
    exporter.clear();
    expect(exporter.spans).toHaveLength(0);
  });
});
