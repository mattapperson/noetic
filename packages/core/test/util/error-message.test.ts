import { describe, expect, it } from 'bun:test';
import { errorMessage, isRpcError, RpcFailure } from '../../src/util/error-message';

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

describe('errorMessage edge cases', () => {
  it('keeps an empty Error message empty', () => {
    expect(errorMessage(new Error())).toBe('');
  });

  it('names a bare code', () => {
    expect(
      errorMessage({
        code: -32603,
      }),
    ).toBe('JSON-RPC error (-32603)');
  });

  it('reads a non-RPC object by its message', () => {
    expect(
      errorMessage({
        message: 'plain',
      }),
    ).toBe('plain');
  });

  it('treats a DOMException as a plain error, not a JSON-RPC one', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(isRpcError(abort)).toBe(false);
    expect(errorMessage(abort)).toBe('This operation was aborted');
  });
});

describe('RpcFailure', () => {
  it('carries the readable message, the code, the data and the original', () => {
    const original = new RequestError(-32000, 'Authentication required', {
      methods: [
        'oauth',
      ],
    });
    const failure = new RpcFailure(original);
    expect(failure.message).toBe('Authentication required: {"methods":["oauth"]} (-32000)');
    expect(failure.code).toBe(-32000);
    expect(failure.data).toEqual({
      methods: [
        'oauth',
      ],
    });
    expect(failure.cause).toBe(original);
  });

  it('leaves code and data undefined for a value without them', () => {
    const failure = new RpcFailure('boom');
    expect(failure.message).toBe('boom');
    expect(failure.code).toBeUndefined();
    expect(failure.data).toBeUndefined();
  });
});
