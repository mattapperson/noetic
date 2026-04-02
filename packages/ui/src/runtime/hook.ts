/**
 * @noetic/ui Execution Hooks
 *
 * Execution hooks for capturing step events with zero overhead when debugging is disabled.
 * These hooks check for debugger presence before executing, ensuring no performance impact
 * in production environments.
 */

import type { Context } from '@noetic/core';
import type { Debugger } from './debugger';

import type { StepKind } from './types';

/** Minimal step metadata needed by hooks — avoids variance issues with full Step<M,I,O> */
export interface StepMeta {
  id: string;
  kind: StepKind;
}

/**
 * Hook manager for registering and executing debug hooks
 *
 * Provides conditional hook registration that only activates when debugging is enabled,
 * ensuring zero overhead in production. This is designed for tree-shaking compatibility
 * - the hooks module is only imported when NOETIC_UI_ENABLED is true.
 */
export class HookManager {
  private debugger: Debugger | null = null;
  private hooksEnabled = false;

  /**
   * Attach a debugger to start receiving events
   * This activates the hooks and enables event capture
   */
  attachDebugger(debugger_: Debugger): void {
    this.debugger = debugger_;
    this.hooksEnabled = true;
  }

  /**
   * Detach the debugger and disable hooks
   */
  detachDebugger(): void {
    this.debugger = null;
    this.hooksEnabled = false;
  }

  /**
   * Check if hooks are currently enabled
   * Use this to guard expensive debug operations
   */
  get isEnabled(): boolean {
    return this.hooksEnabled && this.debugger?.isAttached === true;
  }

  /**
   * Get the attached debugger instance
   */
  getDebugger(): Debugger | null {
    return this.debugger;
  }

  /**
   * Called before a step starts executing
   * Zero overhead when debugging is disabled
   */
  async onStepStart(step: StepMeta, input: unknown, ctx: Context): Promise<void> {
    // Fast path: check if debugging is enabled
    if (!this.hooksEnabled || !this.debugger) {
      return;
    }

    // Double-check debugger is still attached
    if (!this.debugger.isAttached) {
      return;
    }

    await this.debugger.onStepStart(step, input, ctx);
  }

  /**
   * Called after a step completes successfully
   * Zero overhead when debugging is disabled
   */
  async onStepComplete(step: StepMeta, result: unknown, ctx: Context): Promise<void> {
    // Fast path: check if debugging is enabled
    if (!this.hooksEnabled || !this.debugger) {
      return;
    }

    // Double-check debugger is still attached
    if (!this.debugger.isAttached) {
      return;
    }

    await this.debugger.onStepComplete(step, result, ctx);
  }

  /**
   * Called when a step errors
   * Zero overhead when debugging is disabled
   */
  async onStepError(step: StepMeta, error: Error, ctx: Context): Promise<void> {
    // Fast path: check if debugging is enabled
    if (!this.hooksEnabled || !this.debugger) {
      return;
    }

    // Double-check debugger is still attached
    if (!this.debugger.isAttached) {
      return;
    }

    await this.debugger.onStepError(step, error, ctx);
  }

  /**
   * Called when a run starts
   */
  onRunStart(agentId: string, runId: string, input: unknown): void {
    if (!this.hooksEnabled || !this.debugger) {
      return;
    }

    this.debugger.startRun(agentId, runId, input);
  }

  /**
   * Called when a run completes
   */
  onRunComplete(status: 'completed' | 'error' | 'cancelled' = 'completed'): void {
    if (!this.hooksEnabled || !this.debugger) {
      return;
    }

    this.debugger.endRun(status);
  }
}

/**
 * Global hook manager instance
 *
 * This singleton provides a single point of access for debug hooks throughout the runtime.
 * It's designed to be tree-shaken when not used.
 */
export const globalHookManager = new HookManager();

/**
 * Convenience hook function for step start
 * Checks for debugger presence before executing
 */
export async function onStepStart(step: StepMeta, input: unknown, ctx: Context): Promise<void> {
  return globalHookManager.onStepStart(step, input, ctx);
}

/**
 * Convenience hook function for step completion
 * Checks for debugger presence before executing
 */
export async function onStepComplete(step: StepMeta, result: unknown, ctx: Context): Promise<void> {
  return globalHookManager.onStepComplete(step, result, ctx);
}

/**
 * Convenience hook function for step errors
 * Checks for debugger presence before executing
 */
export async function onStepError(step: StepMeta, error: Error, ctx: Context): Promise<void> {
  return globalHookManager.onStepError(step, error, ctx);
}

/**
 * Convenience hook function for run start
 */
export function onRunStart(agentId: string, runId: string, input: unknown): void {
  globalHookManager.onRunStart(agentId, runId, input);
}

/**
 * Convenience hook function for run complete
 */
export function onRunComplete(status: 'completed' | 'error' | 'cancelled' = 'completed'): void {
  globalHookManager.onRunComplete(status);
}

/**
 * Check if debugging hooks are enabled
 * Use this for conditional debug logic with zero overhead
 */
export function isDebuggingEnabled(): boolean {
  return globalHookManager.isEnabled;
}

/**
 * Get the attached debugger if any
 */
export function getAttachedDebugger(): Debugger | null {
  return globalHookManager.getDebugger();
}
