/** Shared formatting utilities for the UI package. */

export const formatDuration = (ms: number): string => {
  if (ms < 1e3) {
    return `${ms}ms`;
  }
  if (ms < 6e4) {
    return `${(ms / 1e3).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 6e4);
  const seconds = ((ms % 6e4) / 1e3).toFixed(0);
  return `${minutes}m ${seconds}s`;
};

export const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  // Use ISO time format to avoid hydration mismatches with locale-dependent toLocaleTimeString
  return date.toISOString().split('T')[1].slice(0, 8);
};
