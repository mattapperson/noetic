import type { AdapterConfig, FieldMapping } from '../types/adapter';
import type { SourceLocation } from '../types/source-location';

//#region Types

interface RegisteredField {
  provider: string;
  functionName: string;
  paramPath: string;
  fieldType: 'prompt' | 'description' | 'text';
  value: string;
  sourceLocation?: SourceLocation;
}

interface RegisterFieldsContext {
  config: AdapterConfig;
  functionName: string;
  fieldMappings: FieldMapping;
  args: unknown[];
  sourceLocation: SourceLocation | undefined;
}

//#endregion

//#region Global Registry

const registeredFields: RegisteredField[] = [];

//#endregion

//#region Helper Functions

function captureSourceLocation(): SourceLocation | undefined {
  const stack = new Error().stack;
  if (!stack) {
    return undefined;
  }

  const lines = stack.split('\n');
  // Skip: Error, captureSourceLocation, wrapper fn, actual caller
  const callerLine = lines[4];
  if (!callerLine) {
    return undefined;
  }

  const match = callerLine.match(/\((.+):(\d+):(\d+)\)/) ?? callerLine.match(/at (.+):(\d+):(\d+)/);
  if (!match) {
    return undefined;
  }

  return {
    filePath: match[1],
    line: Number.parseInt(match[2], 10),
    column: Number.parseInt(match[3], 10),
  };
}

function extractNestedValue(args: unknown[], paramPath: string): unknown {
  const parts = paramPath.split('.');
  let current: unknown = args;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    const idx = Number.parseInt(part, 10);
    if (!Number.isNaN(idx)) {
      current = Array.isArray(current) ? current[idx] : undefined;
    } else {
      current = Reflect.get(current, part);
    }
  }

  return current;
}

function registerFields(ctx: RegisterFieldsContext): void {
  for (const [paramPath, fieldType] of Object.entries(ctx.fieldMappings)) {
    const value = extractNestedValue(ctx.args, paramPath);
    if (typeof value !== 'string') {
      continue;
    }
    registeredFields.push({
      provider: ctx.config.provider,
      functionName: ctx.functionName,
      paramPath,
      fieldType,
      value,
      sourceLocation: ctx.sourceLocation,
    });
  }
}

//#endregion

//#region Public API

export function getRegisteredFields(): ReadonlyArray<RegisteredField> {
  return registeredFields;
}

export function clearRegisteredFields(): void {
  registeredFields.length = 0;
}

export function createAdapter(
  config: AdapterConfig,
): Record<string, (...args: unknown[]) => unknown> {
  const wrapped: Record<string, (...args: unknown[]) => unknown> = {};

  for (const [name, fn] of Object.entries(config.wrap)) {
    const fieldMappings = config.fields?.[name];
    wrapped[name] = (...args: unknown[]): unknown => {
      const sourceLocation = captureSourceLocation();

      if (fieldMappings) {
        registerFields({
          config,
          functionName: name,
          fieldMappings,
          args,
          sourceLocation,
        });
      }

      return fn(...args);
    };
  }

  return wrapped;
}

//#endregion
