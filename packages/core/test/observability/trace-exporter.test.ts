import { describe, expect, it } from 'bun:test';
import { SpanImpl } from '../../src/observability/span-impl';
import { InMemoryExporter, NoopExporter } from '../../src/observability/trace-exporter';

describe('NoopExporter', () => {
  it('export resolves without error', async () => {
    const exporter = new NoopExporter();
    const result = await exporter.export([
      new SpanImpl('test', null),
    ]);
    expect(result).toBeUndefined();
  });

  it('export can be called multiple times without side effects', async () => {
    const exporter = new NoopExporter();
    const result1 = await exporter.export([
      new SpanImpl('test1', null),
    ]);
    const result2 = await exporter.export([
      new SpanImpl('test2', null),
    ]);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });
});

describe('InMemoryExporter', () => {
  it('collects spans', async () => {
    const exporter = new InMemoryExporter();
    const span = new SpanImpl('test', null);
    await exporter.export([
      span,
    ]);
    expect(exporter.spans).toHaveLength(1);
  });

  it('getSpansByName filters', async () => {
    const exporter = new InMemoryExporter();
    await exporter.export([
      new SpanImpl('a', null),
      new SpanImpl('b', null),
      new SpanImpl('a', null),
    ]);
    expect(exporter.getSpansByName('a')).toHaveLength(2);
    expect(exporter.getSpansByName('b')).toHaveLength(1);
  });

  it('getChildSpans finds children', async () => {
    const exporter = new InMemoryExporter();
    const parent = new SpanImpl('parent', null);
    const child1 = new SpanImpl('child1', parent);
    const child2 = new SpanImpl('child2', parent);
    const unrelated = new SpanImpl('other', null);
    await exporter.export([
      parent,
      child1,
      child2,
      unrelated,
    ]);
    expect(exporter.getChildSpans(parent.spanId)).toHaveLength(2);
  });

  it('getTraceTree returns all spans in trace', async () => {
    const exporter = new InMemoryExporter();
    const root = new SpanImpl('root', null);
    const child = new SpanImpl('child', root);
    const other = new SpanImpl('other', null);
    await exporter.export([
      root,
      child,
      other,
    ]);
    expect(exporter.getTraceTree(root.traceId)).toHaveLength(2);
  });

  it('clear removes all spans', async () => {
    const exporter = new InMemoryExporter();
    await exporter.export([
      new SpanImpl('test', null),
    ]);
    expect(exporter.spans).toHaveLength(1);
    exporter.clear();
    expect(exporter.spans).toHaveLength(0);
  });

  it('records startTrace calls', () => {
    const exporter = new InMemoryExporter();
    exporter.startTrace('trace-1', 'hello');
    expect(exporter.traces).toHaveLength(1);
    expect(exporter.traces[0].traceId).toBe('trace-1');
    expect(exporter.traces[0].input).toBe('hello');
    expect(exporter.traces[0].completed).toBe(false);
  });

  it('records completeTrace calls', () => {
    const exporter = new InMemoryExporter();
    exporter.startTrace('trace-1', 'hello');
    exporter.completeTrace('trace-1');
    expect(exporter.traces[0].completed).toBe(true);
    expect(exporter.traces[0].error).toBeUndefined();
  });

  it('records completeTrace with error', () => {
    const exporter = new InMemoryExporter();
    exporter.startTrace('trace-1', 'hello');
    const err = new Error('boom');
    exporter.completeTrace('trace-1', err);
    expect(exporter.traces[0].completed).toBe(true);
    expect(exporter.traces[0].error).toBe(err);
  });

  it('clear resets traces', () => {
    const exporter = new InMemoryExporter();
    exporter.startTrace('trace-1', 'hello');
    exporter.clear();
    expect(exporter.traces).toHaveLength(0);
  });
});
