import { describe, expect, test } from 'bun:test';

import type { InputMessageItem, Item } from '@noetic-tools/core';

import type { ModalSubmitValues } from '../src/modals';
import { modalToNoeticInput } from '../src/modals';
import { ModalInputMode } from '../src/types';

//#region Helpers

function isInputMessageItem(item: Item): item is InputMessageItem {
  return item.type === 'message' && 'role' in item && item.role === 'user';
}

function isItemArray(value: unknown): value is ReadonlyArray<Item> {
  return Array.isArray(value);
}

function createModalEvent(values: Record<string, string>): ModalSubmitValues {
  return {
    callbackId: 'test-modal',
    values,
  };
}

//#endregion

describe('modalToNoeticInput', () => {
  test('default mode returns user message string', () => {
    const event = createModalEvent({
      name: 'John',
      email: 'john@example.com',
    });

    const result = modalToNoeticInput(event);

    expect(typeof result).toBe('string');
    expect(result).toContain('name: John');
    expect(result).toContain('email: john@example.com');
  });

  test('structured mode returns Item array', () => {
    const event = createModalEvent({
      feedback: 'Great product',
    });

    const result = modalToNoeticInput(event, {
      mode: ModalInputMode.Structured,
    });

    expect(Array.isArray(result)).toBe(true);
    if (!isItemArray(result)) {
      throw new Error('Expected Item array');
    }
    expect(result).toHaveLength(1);
    const item = result[0];
    if (!isInputMessageItem(item)) {
      throw new Error('Expected InputMessageItem');
    }
    expect(item.role).toBe('user');
    const part = item.content[0];
    if (part.type !== 'input_text') {
      throw new Error('Expected input_text content part');
    }
    expect(part.text).toContain('feedback: Great product');
  });

  test('custom mapper overrides mode', () => {
    const event = createModalEvent({
      query: 'search term',
    });

    const result = modalToNoeticInput(event, {
      mode: ModalInputMode.Structured,
      mapper: (values) => `Custom: ${values.query}`,
    });

    expect(result).toBe('Custom: search term');
  });

  test('custom mapper receives event', () => {
    const event = createModalEvent({
      x: 'y',
    });

    let receivedCallbackId = '';
    modalToNoeticInput(event, {
      mapper: (_values, evt) => {
        receivedCallbackId = evt.callbackId;
        return 'ok';
      },
    });

    expect(receivedCallbackId).toBe('test-modal');
  });

  test('message mode with empty values returns empty string', () => {
    const event = createModalEvent({});

    const result = modalToNoeticInput(event);

    expect(result).toBe('');
  });

  test('structured mode generates unique item IDs', () => {
    const event = createModalEvent({
      a: '1',
    });

    const result1 = modalToNoeticInput(event, {
      mode: ModalInputMode.Structured,
    });
    const result2 = modalToNoeticInput(event, {
      mode: ModalInputMode.Structured,
    });

    if (!isItemArray(result1) || !isItemArray(result2)) {
      throw new Error('Expected Item arrays');
    }
    const first = result1[0];
    const second = result2[0];
    if (!isInputMessageItem(first) || !isInputMessageItem(second)) {
      throw new Error('Expected input message items');
    }
    expect(first.id).not.toBe(second.id);
  });
});
