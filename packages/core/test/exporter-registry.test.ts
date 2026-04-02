import { beforeEach, describe, expect, it } from 'bun:test';
import {
  clearExporterFactory,
  getRegisteredExporter,
  registerExporterFactory,
} from '../src/observability/exporter-registry';
import type { TraceExporter } from '../src/types/observability';

class MockExporter implements TraceExporter {
  exportCount = 0;
  async export(): Promise<void> {
    this.exportCount++;
  }
}

describe('exporter registry', () => {
  beforeEach(() => {
    clearExporterFactory();
  });

  it('returns null when no factory registered', () => {
    expect(getRegisteredExporter()).toBeNull();
  });

  it('returns exporter from registered factory', () => {
    registerExporterFactory(() => new MockExporter());
    const exporter = getRegisteredExporter();
    expect(exporter).toBeInstanceOf(MockExporter);
  });

  it('caches the factory result (singleton)', () => {
    let callCount = 0;
    registerExporterFactory(() => {
      callCount++;
      return new MockExporter();
    });
    const first = getRegisteredExporter();
    const second = getRegisteredExporter();
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it('clearExporterFactory resets everything', () => {
    registerExporterFactory(() => new MockExporter());
    expect(getRegisteredExporter()).not.toBeNull();
    clearExporterFactory();
    expect(getRegisteredExporter()).toBeNull();
  });

  it('overwriting factory invalidates cache', () => {
    const first = new MockExporter();
    const second = new MockExporter();
    registerExporterFactory(() => first);
    expect(getRegisteredExporter()).toBe(first);
    registerExporterFactory(() => second);
    expect(getRegisteredExporter()).toBe(second);
  });
});
