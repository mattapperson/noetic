/**
 * Global debugger registry.
 * Maps traceId to active Debugger instances so the WebSocket server
 * can locate and control running debuggers.
 */

import type { DebugController } from './types';

const registry = new Map<string, DebugController>();

export function registerDebugger(traceId: string, controller: DebugController): void {
  registry.set(traceId, controller);
}

export function unregisterDebugger(traceId: string): void {
  registry.delete(traceId);
}

export function getDebugger(traceId: string): DebugController | null {
  return registry.get(traceId) ?? null;
}

export function getAllDebuggers(): Map<string, DebugController> {
  return new Map(registry);
}
