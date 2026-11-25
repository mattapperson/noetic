import { describe, expect, it } from 'bun:test';
import { errorMessage, isRpcError } from '../../src/util/error-message';

class RequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

describe('errorMessage', () => {
  it('reads a plain JSON-RPC error object instead of [object Object]', () => {
    expect(
      errorMessage({
        code: -32000,
        message: 'Authentication required',
      }),
    ).toBe('Authentication required (-32000)');
  });

  it("appends a RequestError's data message to its generic message", () => {
    expect(
      errorMessage(
        new RequestError(-32603, 'Internal error', {
          message: 'Authentication required',
        }),
      ),
    ).toBe('Internal error: Authentication required (-32603)');
  });

  it('reads `details` and string data', () => {
    expect(
      errorMessage(
        new RequestError(-32603, 'Internal error', {
          details: 'model gpt-6-astra needs a newer Codex',
        }),
      ),
    ).toBe('Internal error: model gpt-6-astra needs a newer Codex (-32603)');
    expect(
      errorMessage({
        message: 'Invalid params',
        data: 'bad mode',
      }),
    ).toBe('Invalid params: bad mode');
  });

  it('serializes other data, bounded', () => {
    const text = errorMessage({
      message: 'Invalid params',
      data: {
        issues: 'x'.repeat(2e3),
      },
    });
    expect(text.startsWith('Invalid params: {"issues":"xxx')).toBe(true);
    expect(text.length).toBeLessThan(600);
  });

  it('does not repeat a detail equal to the message', () => {
    expect(
      errorMessage({
        message: 'Authentication required',
        data: {
          message: 'Authentication required',
        },
      }),
    ).toBe('Authentication required');
  });

  it('falls back to the data, then to the object, when there is no message', () => {
    expect(
      errorMessage({
        data: {
          message: 'only detail',
        },
      }),
    ).toBe('only detail');
    expect(
      errorMessage({
        reason: 'x',
      }),
    ).toBe('{"reason":"x"}');
  });

  it('handles plain errors and non-objects', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('text')).toBe('text');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });

  it('survives an object that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorMessage(cyclic)).toBe('[object Object]');
  });
});

describe('isRpcError', () => {
  it('is true for anything carrying a numeric code or data', () => {
    expect(isRpcError(new RequestError(-32603, 'Internal error'))).toBe(true);
    expect(
      isRpcError({
        message: 'x',
        data: {},
      }),
    ).toBe(true);
  });

  it('is false for plain errors, string codes and non-objects', () => {
    expect(isRpcError(new Error('boom'))).toBe(false);
    expect(
      isRpcError(
        Object.assign(new Error('missing'), {
          code: 'ENOENT',
        }),
      ),
    ).toBe(false);
    expect(isRpcError('x')).toBe(false);
    expect(isRpcError(null)).toBe(false);
  });
});
