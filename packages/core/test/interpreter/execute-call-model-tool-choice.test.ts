import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { CallModelRequest, StepCallModel } from '@noetic-tools/types';
import { executeCallModel } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeLLMResponse, makeMockHarness, makeTestTool } from '../_helpers';

describe('executeCallModel toolChoice', () => {
  it('forwards the step toolChoice alongside the tool restriction', async () => {
    const harness = makeMockHarness();
    const requests: CallModelRequest[] = [];
    harness.callModel = async (request) => {
      requests.push(request);
      return makeLLMResponse('done');
    };
    const search = makeTestTool();
    const ctx = new ContextImpl({
      harness,
    });
    ctx.unifiedTools = [
      search,
    ];
    const step: StepCallModel<ContextData, string, string> = {
      kind: 'callModel',
      id: 'forced',
      model: 'test/model',
      tools: [
        search,
      ],
      toolChoice: {
        tool: 'test-tool',
      },
    };

    await executeCallModel(step, 'go', ctx, undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolChoice).toEqual({
      tool: 'test-tool',
    });
    expect(requests[0]?.allowedToolNames).toEqual([
      'test-tool',
    ]);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
  });
});
