import { describe, expect, it } from 'bun:test';
import { findFunctionCall } from '@noetic-tools/memory';
import { makeFunctionCall, makeMessage } from '../_helpers';

describe('findFunctionCall', () => {
  it('returns parsed args when a matching function_call exists', () => {
    const items = [
      makeMessage('user', 'hello'),
      makeFunctionCall('updateWorkingMemory', '{"key":"value"}'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toEqual({
      key: 'value',
    });
  });

  it('returns null when no matching function_call exists', () => {
    const items = [
      makeMessage('user', 'hello'),
      makeFunctionCall('otherFunction', '{"key":"value"}'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON arguments', () => {
    const items = [
      makeFunctionCall('updateWorkingMemory', 'not-json'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toBeNull();
  });

  it('skips non-object arguments (array)', () => {
    const items = [
      makeFunctionCall('updateWorkingMemory', '[1,2,3]'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toBeNull();
  });

  it('skips null arguments', () => {
    const items = [
      makeFunctionCall('updateWorkingMemory', 'null'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toBeNull();
  });

  it('returns the first match when multiple exist', () => {
    const items = [
      makeFunctionCall('updateWorkingMemory', '{"first":true}'),
      makeFunctionCall('updateWorkingMemory', '{"second":true}'),
    ];
    const result = findFunctionCall(items, 'updateWorkingMemory');
    expect(result).toEqual({
      first: true,
    });
  });

  it('returns null for an empty items array', () => {
    const result = findFunctionCall([], 'updateWorkingMemory');
    expect(result).toBeNull();
  });
});
