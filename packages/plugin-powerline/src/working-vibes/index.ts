import type { VibeOptions } from '../options.js';
import { loadVibesFromFile } from './file.js';
import { generateVibes } from './generate.js';

interface ResolveArgs {
  options: VibeOptions;
  apiKey: string;
}

export async function resolveVibes(args: ResolveArgs): Promise<ReadonlyArray<string>> {
  const { options, apiKey } = args;
  if (options.mode === 'off') {
    return [];
  }
  if (options.mode === 'file') {
    const fromFile = loadVibesFromFile(options.theme);
    return fromFile.length > 0
      ? fromFile
      : [
          options.fallback,
        ];
  }
  // generate
  try {
    const generated = await generateVibes({
      apiKey,
      theme: options.theme,
      poolSize: options.poolSize,
    });
    if (generated.length > 0) {
      return generated;
    }
  } catch {
    // fall through to fallback
  }
  return [
    options.fallback,
  ];
}

export { loadVibesFromFile } from './file.js';
export { generateVibes, parseMessagesFromContent } from './generate.js';
