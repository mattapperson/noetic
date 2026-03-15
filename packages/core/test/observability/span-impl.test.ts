import { describe, expect, it } from 'bun:test';
import { SpanImpl } from '../../src/observability/span-impl';

describe('SpanImpl', () => {
  it('creates with IDs', () => {
    const span = new SpanImpl('test', null);
    expect(typeof span.traceId).toBe('string');
    expect(span.traceId.length).toBeGreaterThan(0);
    expect(typeof span.spanId).toBe('string');
    expect(span.spanId.length).toBeGreaterThan(0);
    expect(span.parentSpanId).toBeNull();
    expect(span.name).toBe('test');
  });

  it('child spans reference parent', () => {
    const parent = new SpanImpl('parent', null);
    const child = new SpanImpl('child', parent);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
  });

  it('setAttribute stores values', () => {
    const span = new SpanImpl('test', null);
    span.setAttribute('key', 'value');
    span.setAttribute('count', 42);
    span.setAttribute('flag', true);
    expect(span.attributes.get('key')).toBe('value');
    expect(span.attributes.get('count')).toBe(42);
    expect(span.attributes.get('flag')).toBe(true);
  });

  it('addEvent records events', () => {
    const span = new SpanImpl('test', null);
    span.addEvent('start', {
      step: 'init',
    });
    span.addEvent('end');
    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe('start');
    expect(span.events[0].attributes?.step).toBe('init');
  });

  it('end() sets endTime', () => {
    const span = new SpanImpl('test', null);
    expect(span.endTime).toBeUndefined();
    span.end();
    expect(span.endTime).toBeDefined();
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
  });

  it('duration computed correctly', () => {
    const span = new SpanImpl('test', null);
    span.end();
    expect(span.duration).toBeGreaterThanOrEqual(0);
    expect(span.duration).toBeLessThan(100);
    expect(span.duration).toBe(span.endTime! - span.startTime);
  });

  it('un-ended span returns live elapsed time', () => {
    const span = new SpanImpl('test', null);
    expect(span.duration).toBeGreaterThanOrEqual(0);
    expect(span.endTime).toBeUndefined();
  });
});
