const DEFAULT_WARN_BYTES = 10 * 1024 * 1024; // 10MB

function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function cloneWithGuard<T>(
  value: T,
  label: string,
  opts?: {
    warnBytes?: number;
    maxBytes?: number;
  },
): T {
  const warnBytes = opts?.warnBytes ?? DEFAULT_WARN_BYTES;
  const size = estimateSize(value);

  if (size > warnBytes) {
    console.warn(
      `[orchid] ${label}: state size (~${Math.round(size / 1024 / 1024)}MB) exceeds ${Math.round(warnBytes / 1024 / 1024)}MB threshold. ` +
        'Consider reducing state size to avoid performance issues.',
    );
  }

  return structuredClone(value);
}
