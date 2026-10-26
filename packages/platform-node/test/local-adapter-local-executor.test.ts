/**
 * Regression: the local subprocess adapter MUST honor an inline
 * `_localExecutor` when no `registryEntry` is configured.
 *
 * The interpreter wraps every same-process step dispatch with a
 * `_localExecutor` closure. If the adapter rejects the request because
 * `registryEntry` is missing, every `spawn()` step in the workflow
 * (e.g. the code-agent plan/act/verify agents) fails instantly and the
 * CLI never produces a response.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StepSubprocessRequest } from '@noetic-tools/core';
import { createLocalSubprocessAdapter } from '../src/local-subprocess-adapter';

describe('local adapter in-process step dispatch', () => {
  it('runs _localExecutor in-process when registryEntry is not configured', async () => {
    const adapter = createLocalSubprocessAdapter();
    const request: StepSubprocessRequest = {
      kind: 'step',
      stepId: 'test/echo',
      serializedInput: 'input-value',
      executionId: 'ctx-1',
      overrides: {
        threadId: 'thread-1',
      },
      _localExecutor: async () => 'result-value',
    };
    const { handle, settled } = await adapter.spawn(request);
    expect(handle.status).toBe('running');

    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.metadata?.result).toBe('result-value');
    expect(await adapter.get(handle.id)).toBeNull();
  });

  it('surfaces executor errors as failed handles with serialized error metadata', async () => {
    const adapter = createLocalSubprocessAdapter();
    const request: StepSubprocessRequest = {
      kind: 'step',
      stepId: 'test/boom',
      serializedInput: null,
      executionId: 'ctx-2',
      overrides: {
        threadId: 'thread-2',
      },
      _localExecutor: async () => {
        throw new Error('boom');
      },
    };
    const final = await (await adapter.spawn(request)).settled;
    expect(final.status).toBe('failed');
    const error = final.metadata?.error;
    expect(error).toBeInstanceOf(Object);
    assert(error && typeof error === 'object' && 'message' in error);
    expect(error.message).toBe('boom');
  });

  it('still rejects step requests when neither registryEntry nor _localExecutor is provided', async () => {
    const adapter = createLocalSubprocessAdapter();
    const request: StepSubprocessRequest = {
      kind: 'step',
      stepId: 'test/no-executor',
      serializedInput: null,
      executionId: 'ctx-3',
      overrides: {
        threadId: 'thread-3',
      },
    };
    expect(adapter.spawn(request)).rejects.toThrow(/registryEntry/);
  });
});
