/**
 * JSON formatting and syntax highlighting utilities for the Noetic UI
 * Provides JSON tree visualization and syntax highlighting
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export interface FormattedNode {
  key: string;
  value: JsonValue;
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  depth: number;
  isExpandable: boolean;
  children?: FormattedNode[];
}

/**
 * Format a JSON value into a displayable structure
 */
export function formatJsonValue(value: unknown, key = '', depth = 0): FormattedNode {
  const type = getValueType(value);
  // biome-ignore lint: Value validated as JSON-compatible by getValueType
  const jsonValue = value as JsonValue;
  const node: FormattedNode = {
    key,
    value: jsonValue,
    type,
    depth,
    isExpandable: type === 'object' || type === 'array',
  };

  if (node.isExpandable) {
    if (type === 'array' && Array.isArray(value)) {
      node.children = value.map((item, index) => formatJsonValue(item, String(index), depth + 1));
    } else if (type === 'object' && value !== null && typeof value === 'object') {
      node.children = Object.entries(value).map(([k, v]) => formatJsonValue(v, k, depth + 1));
    }
  }

  return node;
}

/**
 * Get the type of a value for syntax highlighting
 */
export function getValueType(value: unknown): FormattedNode['type'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'null';
}

/**
 * Format a value as a display string
 */
export function formatValue(value: unknown, type: FormattedNode['type']): string {
  switch (type) {
    case 'string':
      return `"${String(value)}"`;
    case 'number':
      return String(value);
    case 'boolean':
      return String(value);
    case 'null':
      return 'null';
    case 'array':
      if (Array.isArray(value)) {
        return `Array(${value.length})`;
      }
      return 'Array';
    case 'object':
      if (value && typeof value === 'object') {
        return `Object(${Object.keys(value).length})`;
      }
      return 'Object';
    default:
      return String(value);
  }
}

/**
 * Pretty print JSON with indentation
 */
export function prettyPrintJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch (error) {
    console.error('[JSON] Failed to stringify value:', error);
    return String(value);
  }
}

/**
 * Truncate a string to a maximum length
 */
export function truncateString(str: string, maxLength = 100): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Estimate the size of a value in bytes (rough approximation)
 */
export function estimateSize(value: unknown): number {
  try {
    return new Blob([
      JSON.stringify(value),
    ]).size;
  } catch (error) {
    console.error('[JSON] Failed to estimate size:', error);
    return 0;
  }
}

/**
 * Format bytes into a human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = [
    'B',
    'KB',
    'MB',
    'GB',
  ];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Number.parseFloat((bytes / k ** i).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Syntax highlighting colors for JSON types (CSS variable names)
 */
export const syntaxColors: Record<FormattedNode['type'], string> = {
  string: 'var(--noetic-json-string)',
  number: 'var(--noetic-json-number)',
  boolean: 'var(--noetic-json-boolean)',
  null: 'var(--noetic-json-null)',
  array: 'var(--noetic-json-array)',
  object: 'var(--noetic-json-object)',
};

/**
 * Dark theme syntax colors (fallback values)
 */
export const darkSyntaxColors: Record<FormattedNode['type'], string> = {
  string: '#a5d6ff',
  number: '#79c0ff',
  boolean: '#ff7b72',
  null: '#ff7b72',
  array: '#d2a8ff',
  object: '#d2a8ff',
};

/**
 * Light theme syntax colors (fallback values)
 */
export const lightSyntaxColors: Record<FormattedNode['type'], string> = {
  string: '#0550ae',
  number: '#0550ae',
  boolean: '#cf222e',
  null: '#cf222e',
  array: '#6639ba',
  object: '#6639ba',
};

/**
 * Get syntax color for a type
 */
export function getSyntaxColor(type: FormattedNode['type'], isDark = true): string {
  const colors = isDark ? darkSyntaxColors : lightSyntaxColors;
  return colors[type];
}

/**
 * Check if a value is empty (empty object, array, or null/undefined)
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  return false;
}

/**
 * Deep clone a value
 */
export function deepClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.error('[JSON] Failed to deep clone value:', error);
    return value;
  }
}

/**
 * Get a preview string for a value (first 50 chars)
 */
export function getPreview(value: unknown, maxLength = 50): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return truncateString(value, maxLength);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `Object(${keys.length}) {${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
  }
  return truncateString(String(value), maxLength);
}
