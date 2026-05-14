import type { FsAdapter } from '@noetic-tools/core';

export function resolveAdapterPath(cwd: string, input: string | undefined): string {
  const raw = (input ?? '.').trim();
  const absolute = raw.startsWith('/') ? raw : `${cwd}/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function dirname(path: string): string {
  const normalized = resolveAdapterPath('/', path);
  if (normalized === '/') {
    return '/';
  }
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

export function basename(path: string): string {
  const normalized = resolveAdapterPath('/', path);
  if (normalized === '/') {
    return '';
  }
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function joinAdapterPath(base: string, segment: string): string {
  return resolveAdapterPath(base, segment);
}

export async function atomicWriteText(
  fs: FsAdapter,
  target: string,
  content: string,
): Promise<void> {
  await fs.mkdir(dirname(target));
  const tmp = `${target}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, content);
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

export function safePluginNameSegment(name: string): string {
  const bare = name.startsWith('@') ? name.split('/').slice(1).join('-') : name;
  const segment = bare.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) {
    throw new Error(`Invalid plugin name segment: ${name}`);
  }
  return segment;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
