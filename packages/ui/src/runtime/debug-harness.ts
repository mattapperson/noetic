/**
 * @noetic/ui Debug Harness
 *
 * DebugAgentHarness wrapper that provides debugging capabilities around
 * the standard AgentHarness. Supports pause/resume, breakpoints, and
 * step-by-step execution control.
 */

import type {
  AgentConfig,
  CallModelRequest,
  Context,
  ContextMemory,
  ExecuteInput,
  ExecuteOptions,
  Item,
  LLMResponse,
  MemoryLayer,
  Span,
  Step,
  Tool,
  TraceExporter,
} from '@noetic/core';
import { AgentHarness } from '@noetic/core';
import type { ZodType } from 'zod';
import { Debugger } from './debugger';
import { NoeticUITraceExporter } from './exporter';
import { globalHookManager } from './hook';
import type { Breakpoint, DebugController, DebuggerConfig, ExporterOptions } from './types';

/**
 * Configuration options for the debug harness
 */
export interface DebugHarnessConfig<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Agent name */
  name: string;
  /** Initial step to execute */
  initialStep?: Step<ContextMemory, string, string>;
  /** Agent parameters */
  params?: TParams;
  /** Parameter validation schema */
  paramsSchema?: ZodType<TParams>;
  /** Memory layers */
  layers?: MemoryLayer[];
  /** Tools available to the agent */
  tools?: Tool[];
  /** LLM provider configuration */
  llm?: {
    provider: 'openrouter';
    apiKey: string;
    model?: string;
  };
  /** Debug configuration */
  debugger?: DebuggerConfig;
  /** Exporter options for WebSocket connection */
  exporterOptions?: ExporterOptions;
  /** Optional external trace exporter */
  traceExporter?: TraceExporter;
}

/**
 * DebugAgentHarness extends AgentHarness with debugging capabilities
 *
 * This wrapper provides:
 * - Breakpoint support with condition evaluation
 * - Pause/resume execution control
 * - Step-by-step debugging (step over, into, out)
 * - Real-time trace export to UI server
 * - Zero overhead when debugging is disabled
 *
 * @example
 * ```typescript
 * import { createDebugHarness } from '@noetic/ui/runtime';
 *
 * const harness = createDebugHarness({
 *   name: 'my-agent',
 *   initialStep: myStep,
 *   debugger: {
 *     breakpoints: ['step-3', 'verify-loop'],
 *     pauseOnError: true,
 *     autoStart: false,
 *   }
 * });
 *
 * // Execution automatically pauses at breakpoints
 * const result = await harness.execute('user input');
 * ```
 */
export class DebugAgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>> {
  private baseHarness: AgentHarness<TParams>;
  private debugger_: Debugger | null = null;
  private exporter: NoeticUITraceExporter | null = null;
  private debugConfig: DebuggerConfig;

  constructor(config: DebugHarnessConfig<TParams>) {
    // Create exporter if options provided or create default
    this.exporter = config.traceExporter
      ? null
      : new NoeticUITraceExporter(
          config.exporterOptions ?? {
            port: 3333,
          },
        );

    // Create base harness with our exporter
    this.baseHarness = new AgentHarness<TParams>({
      name: config.name,
      initialStep: config.initialStep,
      // biome-ignore lint: Type assertion needed for generic TParams with default - {} is always valid for Record<string, unknown>
      params: (config.params ?? {}) as TParams,
      paramsSchema: config.paramsSchema,
      traceExporter: config.traceExporter ?? this.exporter ?? undefined,
    });

    this.debugConfig = config.debugger ?? {};

    // Initialize debugger if config provided
    if (Object.keys(this.debugConfig).length > 0 || process.env.NOETIC_UI_ENABLED) {
      this.setupDebugger();
    }
  }

  /**
   * Execute with full debugging support
   */
  async execute(input: ExecuteInput, options?: ExecuteOptions): Promise<string> {
    const runId = crypto.randomUUID();
    const agentId = this.baseHarness.config.name;

    // Convert input for logging
    const inputData =
      typeof input === 'string'
        ? input
        : Array.isArray(input)
          ? input
          : [
              input,
            ];

    // Register agent with UI server
    if (this.exporter) {
      this.exporter.sendEvent({
        type: 'agent.register',
        agentId,
        agentName: this.baseHarness.config.name,
        timestamp: Date.now(),
      });
    }

    // Start debug run
    if (this.debugger_) {
      globalHookManager.onRunStart(agentId, runId, inputData);
    }

    try {
      const result = await this.baseHarness.execute(input, options);

      // Complete successfully
      if (this.debugger_) {
        globalHookManager.onRunComplete('completed');
      }

      // Get the text output from the result
      return await result.getText();
    } catch (error) {
      // Complete with error
      if (this.debugger_) {
        globalHookManager.onRunComplete('error');
      }
      throw error;
    }
  }

  /**
   * Run a specific step with debugging
   */
  async run<I, O>(step: Step, input: I, ctx: Context): Promise<O> {
    // If debugging is active, wrap execution with hooks
    if (this.debugger_?.isAttached) {
      await globalHookManager.onStepStart(step, input, ctx);

      try {
        // biome-ignore lint: Type assertion needed - base harness returns generic type that must be cast to output type O
        const result = (await this.baseHarness.run(step, input, ctx)) as O;
        await globalHookManager.onStepComplete(step, result, ctx);
        return result;
      } catch (error) {
        await globalHookManager.onStepError(
          step,
          error instanceof Error ? error : new Error(String(error)),
          ctx,
        );
        throw error;
      }
    }

    // Normal execution without debugging
    // biome-ignore lint: Type assertion needed - base harness returns generic type that must be cast to output type Promise<O>
    return this.baseHarness.run(step, input, ctx) as Promise<O>;
  }

  /**
   * Get the underlying AgentHarness
   */
  get harness(): AgentHarness<TParams> {
    return this.baseHarness;
  }

  /**
   * Get the debugger instance for control
   */
  get debugger(): DebugController | null {
    return this.debugger_;
  }

  /**
   * Check if debugging is currently enabled
   */
  get isDebugging(): boolean {
    return this.debugger_?.isAttached ?? false;
  }

  /**
   * Pause execution at the current step
   */
  pause(): void {
    this.debugger_?.pause();
  }

  /**
   * Resume execution after a pause
   */
  resume(): void {
    this.debugger_?.resume();
  }

  /**
   * Step over the current step
   */
  stepOver(): void {
    this.debugger_?.stepOver();
  }

  /**
   * Step into child steps
   */
  stepInto(): void {
    this.debugger_?.stepInto();
  }

  /**
   * Step out of the current context
   */
  stepOut(): void {
    this.debugger_?.stepOut();
  }

  /**
   * Add a breakpoint
   */
  addBreakpoint(breakpoint: Breakpoint | string): void {
    const normalized =
      typeof breakpoint === 'string'
        ? {
            stepId: breakpoint,
          }
        : breakpoint;
    this.debugger_?.addBreakpoint(normalized);
  }

  /**
   * Remove a breakpoint
   */
  removeBreakpoint(stepId: string): void {
    this.debugger_?.removeBreakpoint(stepId);
  }

  /**
   * Clean up resources
   */
  close(): void {
    this.exporter?.close();
    globalHookManager.detachDebugger();
  }

  // Delegate methods to base harness

  get config(): AgentConfig<TParams> {
    return this.baseHarness.config;
  }

  async callModel(request: CallModelRequest): Promise<LLMResponse> {
    return this.baseHarness.callModel(request);
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
  }): Context {
    return this.baseHarness.createContext(opts);
  }

  createSpan(name: string, parent: Span | null): Span {
    return this.baseHarness.createSpan(name, parent);
  }

  private setupDebugger(): void {
    // Create debugger with event handler
    this.debugger_ = new Debugger(
      this.debugConfig,
      this.exporter ? (msg) => this.exporter?.sendEvent(msg) : undefined,
    );

    // Attach to global hook manager
    globalHookManager.attachDebugger(this.debugger_);
  }
}

/**
 * Create a debug-enabled agent harness
 *
 * Factory function for creating a DebugAgentHarness with sensible defaults.
 * This is the primary entry point for using the Noetic UI debugging features.
 *
 * @example
 * ```typescript
 * import { createDebugHarness } from '@noetic/ui/runtime';
 * import { step } from '@noetic/core';
 *
 * const harness = createDebugHarness({
 *   name: 'code-review-agent',
 *   initialStep: step(...),
 *   debugger: {
 *     breakpoints: ['validate-input'],
 *     pauseOnError: true,
 *   }
 * });
 *
 * // Execute with debugging
 * const result = await harness.execute('Please review this code');
 *
 * // Clean up when done
 * harness.close();
 * ```
 */
export function createDebugHarness<
  TParams extends Record<string, unknown> = Record<string, unknown>,
>(config: DebugHarnessConfig<TParams>): DebugAgentHarness<TParams> {
  return new DebugAgentHarness(config);
}

/**
 * Check if debug mode should be enabled
 *
 * Returns true if NOETIC_UI_ENABLED environment variable is set
 * or if debugging is explicitly configured.
 */
export function shouldEnableDebug(config?: DebugHarnessConfig): boolean {
  return !!(process.env.NOETIC_UI_ENABLED || config?.debugger || config?.exporterOptions);
}
