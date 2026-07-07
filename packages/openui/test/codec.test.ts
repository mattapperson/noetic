import { describe, expect, test } from 'bun:test';
import { isOutputCodec } from '@noetic-tools/types';
import { openUi } from '../src';
import { testLibrary } from './_helpers';

const SAMPLE = [
  '$tab = "a"',
  'sales = Query("sales_tool", {})',
  'root = Card("Hi")',
].join('\n');

function collectEvents(): {
  events: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
  emit: (type: string, data: Record<string, unknown>) => void;
} {
  const events: Array<{
    type: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    events,
    emit: (type, data) =>
      events.push({
        type,
        data,
      }),
  };
}

describe('openUi codec', () => {
  test('is an OutputCodec carrying the library prompt', () => {
    const codec = openUi(testLibrary());
    expect(isOutputCodec(codec)).toBe(true);
    expect(codec.instructions).toContain('Available components:');
  });

  test('push emits one typed event per completed statement', () => {
    const session = openUi(testLibrary()).start();
    const { events, emit } = collectEvents();
    session.push('$tab = "a"\nsales = Qu', emit);
    session.push('ery("sales_tool", {})\nroot = Card("Hi")\n', emit);
    expect(events.map((e) => e.type)).toEqual([
      'openui.state',
      'openui.query',
      'openui.node',
    ]);
    expect(events[2]?.data.ref).toBe('root');
    expect(events[2]?.data.source).toBe('root = Card("Hi")');
  });

  test('finish is authoritative without any pushes (non-streaming path)', () => {
    const session = openUi(testLibrary()).start();
    const doc = session.finish(SAMPLE);
    expect(doc.root).toBe('root');
    expect(doc.order).toEqual([
      '$tab',
      'sales',
      'root',
    ]);
  });

  test('finish after pushes returns the same document as a fresh parse', () => {
    const codec = openUi(testLibrary());
    const streamed = codec.start();
    const { emit } = collectEvents();
    for (const ch of SAMPLE) {
      streamed.push(ch, emit);
    }
    expect(streamed.finish(SAMPLE)).toEqual(codec.start().finish(SAMPLE));
  });
});
