/**
 * Tests for JSON viewer formatting utilities
 */

import { describe, expect, it } from 'bun:test';
import { formatJsonValue } from '../src/client/lib/json-viewer';

describe('formatJsonValue', () => {
  describe('string unwrapping', () => {
    it('unwraps double-encoded JSON strings', () => {
      // JSON.stringify("hello") produces '"hello"'
      const node = formatJsonValue('"hello"');
      expect(node.type).toBe('string');
      expect(node.value).toBe('hello');
    });

    it('unwraps JSON-encoded objects from string values', () => {
      const jsonStr = '{"key":"val"}';
      const node = formatJsonValue(jsonStr);
      expect(node.type).toBe('object');
      expect(node.isExpandable).toBe(true);
      expect(node.children).toBeDefined();
      expect(node.children!.length).toBe(1);
      expect(node.children![0].key).toBe('key');
      expect(node.children![0].value).toBe('val');
    });

    it('unwraps JSON-encoded arrays from string values', () => {
      const jsonStr = '[1,2,3]';
      const node = formatJsonValue(jsonStr);
      expect(node.type).toBe('array');
      expect(node.isExpandable).toBe(true);
      expect(node.children).toBeDefined();
      expect(node.children!.length).toBe(3);
      expect(node.children![0].value).toBe(1);
      expect(node.children![1].value).toBe(2);
      expect(node.children![2].value).toBe(3);
    });

    it('unwraps JSON-encoded number strings recursively to a number', () => {
      // '"123"' -> JSON.parse -> "123" -> JSON.parse -> 123 (number)
      // formatJsonValue recurses: first unwrap yields string "123",
      // second unwrap yields number 123
      const node = formatJsonValue('"123"');
      expect(node.type).toBe('number');
      expect(node.value).toBe(123);
    });

    it('does NOT unwrap plain strings that are not valid JSON', () => {
      const node = formatJsonValue('hello world');
      expect(node.type).toBe('string');
      expect(node.value).toBe('hello world');
    });

    it('does NOT infinite-recurse on strings that parse to themselves', () => {
      // A string that is not valid JSON should just stay as-is
      const node = formatJsonValue('plain text');
      expect(node.type).toBe('string');
      expect(node.value).toBe('plain text');
    });

    it('handles nested JSON-in-JSON (double-encoded objects)', () => {
      // Double-encoded: JSON.stringify(JSON.stringify({a: 1}))
      // produces '"{\"a\":1}"' — a string containing an escaped JSON object
      const inner = JSON.stringify({
        a: 1,
      });
      const doubleEncoded = JSON.stringify(inner);
      const node = formatJsonValue(doubleEncoded);
      // Should unwrap both layers: first parse yields '{"a":1}', second parse yields {a:1}
      expect(node.type).toBe('object');
      expect(node.isExpandable).toBe(true);
      expect(node.children).toBeDefined();
      expect(node.children![0].key).toBe('a');
      expect(node.children![0].value).toBe(1);
    });
  });

  describe('non-string values', () => {
    it('formats numbers directly', () => {
      const node = formatJsonValue(42);
      expect(node.type).toBe('number');
      expect(node.value).toBe(42);
      expect(node.isExpandable).toBe(false);
    });

    it('formats booleans directly', () => {
      const node = formatJsonValue(true);
      expect(node.type).toBe('boolean');
      expect(node.value).toBe(true);
    });

    it('formats null directly', () => {
      const node = formatJsonValue(null);
      expect(node.type).toBe('null');
      expect(node.value).toBeNull();
    });

    it('formats objects with children', () => {
      const node = formatJsonValue({
        x: 1,
        y: 'two',
      });
      expect(node.type).toBe('object');
      expect(node.isExpandable).toBe(true);
      expect(node.children).toHaveLength(2);
    });

    it('formats arrays with indexed children', () => {
      const node = formatJsonValue([
        10,
        20,
      ]);
      expect(node.type).toBe('array');
      expect(node.isExpandable).toBe(true);
      expect(node.children).toHaveLength(2);
      expect(node.children![0].key).toBe('0');
      expect(node.children![1].key).toBe('1');
    });

    it('sets depth on nested children', () => {
      const node = formatJsonValue({
        nested: {
          deep: true,
        },
      });
      expect(node.depth).toBe(0);
      expect(node.children![0].depth).toBe(1);
      expect(node.children![0].children![0].depth).toBe(2);
    });
  });
});
