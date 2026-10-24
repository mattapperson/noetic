import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { withContext } from '../../src/builders/provide-builder';
import { runCode } from '../../src/builders/step-builders';

describe('withContext', () => {
  it('throws MISSING_CONTEXT_LAYERS when context is omitted', () => {
    try {
      withContext({
        id: 'provide-no-layers',
        child: runCode({
          id: 'provide-no-layers-child',
          execute: async () => 'ok',
        }),
        context: frameworkCast<ContextLayer[]>(undefined),
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_CONTEXT_LAYERS');
    }
  });
});
