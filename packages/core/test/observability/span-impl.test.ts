import { describe, expect, it } from 'bun:test';
import { MAX_SPAN_EVENTS, SpanImpl } from '../../src/observability/span-impl';

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

  describe('event limit', () => {
    it('keeps every event up to MAX_SPAN_EVENTS', () => {
      const span = new SpanImpl('test', null);
      for (let i = 0; i < MAX_SPAN_EVENTS; i++) {
        span.addEvent('tick', {
          i,
        });
      }
      expect(span.events).toHaveLength(MAX_SPAN_EVENTS);
      expect(span.droppedEvents).toBe(0);
    });

    it('drops the oldest event once full and counts it', () => {
      const span = new SpanImpl('test', null);
      for (let i = 0; i < MAX_SPAN_EVENTS + 1; i++) {
        span.addEvent('tick', {
          i,
        });
      }
      expect(span.events).toHaveLength(MAX_SPAN_EVENTS);
      expect(span.droppedEvents).toBe(1);
      expect(span.events[0]?.attributes?.i).toBe(1);
      expect(span.events.at(-1)?.attributes?.i).toBe(MAX_SPAN_EVENTS);
    });

    it('stays bounded under an uncapped loop of verdicts', () => {
      const span = new SpanImpl('loop', null);
      const total = MAX_SPAN_EVENTS * 10;
      for (let i = 0; i < total; i++) {
        span.addEvent('loop.verdict', {
          iteration: i,
          stop: i === total - 1,
        });
      }
      expect(span.events).toHaveLength(MAX_SPAN_EVENTS);
      expect(span.droppedEvents).toBe(total - MAX_SPAN_EVENTS);
      // The latest verdict — the one that stopped the loop — is kept.
      expect(span.events.at(-1)?.attributes?.stop).toBe(true);
    });
  });
});
