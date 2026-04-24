/**
 * JSON deserialization utilities for handling serialized Maps
 * Server serializes Maps as { dataType: 'Map', value: [...] }
 * This module provides the client-side deserialization
 */

/**
 * Type guard for Map entries
 */
function isMapEntry(item: unknown): item is [
  string,
  unknown,
] {
  return Array.isArray(item) && item.length === 2 && typeof item[0] === 'string';
}

/**
 * Type guard for serialized Map
 */
function isSerializedMap(value: unknown): value is {
  dataType: 'Map';
  value: [
    string,
    unknown,
  ][];
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    'dataType' in value &&
    value.dataType === 'Map' &&
    'value' in value &&
    Array.isArray(value.value) &&
    value.value.every(isMapEntry)
  );
}

/**
 * JSON reviver that converts serialized Maps back to actual Map instances
 * @param _key - The key being revived (unused)
 * @param value - The value being revived
 * @returns The revived value, with Maps reconstructed
 */
export function deserializeValue(_key: string, value: unknown): unknown {
  if (isSerializedMap(value)) {
    return new Map(value.value);
  }
  return value;
}

/**
 * Parse JSON with Map support
 * @param json - The JSON string to parse
 * @returns The parsed value with Maps reconstructed
 */
export function parseJSON<T>(json: string): T {
  return JSON.parse(json, deserializeValue) as T;
}

/**
 * Deserialize a value that was serialized by the server
 * Handles nested Maps within objects
 * @param value - The value to deserialize
 * @returns The deserialized value with all Maps reconstructed
 */
export function deserialize<T>(value: unknown): T {
  // For already-parsed objects (from fetch().json()), we need to walk the object tree
  if (value === null || typeof value !== 'object') {
    return value as T;
  }

  if (value instanceof Map) {
    return value as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserialize(item)) as unknown as T;
  }

  // Check if it's a serialized Map
  const obj = value as Record<string, unknown>;
  if (obj.dataType === 'Map' && Array.isArray(obj.value)) {
    const map = new Map<string, unknown>();
    const entries = obj.value;
    for (const entry of entries) {
      if (isMapEntry(entry)) {
        const [key, val] = entry;
        map.set(key, deserialize(val));
      }
    }
    return map as T;
  }

  // Regular object - deserialize all properties recursively
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = deserialize(obj[key]);
  }
  return result as T;
}

/**
 * Type guard to check if a value is a Map
 */
export function isMap<K, V>(value: unknown): value is Map<K, V> {
  return value instanceof Map;
}

/**
 * Convert a serialized Map back to a Map instance
 * Use this when you know a specific field should be a Map
 */
export function ensureMap<K, V>(value: unknown): Map<K, V> {
  if (value instanceof Map) {
    return value;
  }

  // Handle serialized Map format
  if (
    value &&
    typeof value === 'object' &&
    'dataType' in value &&
    value.dataType === 'Map' &&
    'value' in value &&
    Array.isArray(value.value)
  ) {
    const entries = value.value as [
      K,
      V,
    ][];
    return new Map(
      entries.map(([k, v]) => [
        k,
        deserialize(v) as V,
      ]),
    );
  }

  // Fallback: if it's a plain object, convert entries to Map
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return new Map(Object.entries(value as Record<string, V>)) as Map<K, V>;
  }

  return new Map<K, V>();
}
