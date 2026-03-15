import type { Span } from '../types/observability';

export class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  readonly attributes: Map<string, string | number | boolean> = new Map();
  readonly events: Array<{ name: string; timestamp: number; attributes?: Record<string, string | number | boolean> }> = [];

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
    this.events.push({ name, timestamp: Date.now(), attributes });
  }

  end(): void {
    this.endTime = Date.now();
  }

  get duration(): number {
    return (this.endTime ?? Date.now()) - this.startTime;
  }
}
