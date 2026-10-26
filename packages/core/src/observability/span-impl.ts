import type { Span } from '@noetic-tools/types';

/**
 * Most events one span keeps. An uncapped loop adds a `loop.verdict` event to its
 * enclosing span every iteration, and a long-lived span would hold them all, so a
 * span keeps the latest events and counts the rest. 128 matches OpenTelemetry's
 * default event count limit.
 */
export const MAX_SPAN_EVENTS = 128;

export class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  readonly attributes: Map<string, string | number | boolean> = new Map();
  readonly events: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  /** Events dropped, oldest first, once the span held `MAX_SPAN_EVENTS`. */
  droppedEvents = 0;

  constructor(name: string, parent: Span | null, traceId?: string) {
    this.name = name;
    this.traceId = traceId ?? parent?.traceId ?? crypto.randomUUID();
    this.spanId = crypto.randomUUID();
    this.parentSpanId = parent?.spanId ?? null;
    this.startTime = Date.now();
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes.set(key, value);
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
    if (this.events.length > MAX_SPAN_EVENTS) {
      this.events.shift();
      this.droppedEvents += 1;
    }
  }

  end(): void {
    this.endTime = Date.now();
  }

  get duration(): number {
    return (this.endTime ?? Date.now()) - this.startTime;
  }
}
