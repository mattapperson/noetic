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

//#region Config

export interface DebugHarnessConfig<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  initialStep?: Step<ContextMemory, string, string>;
  /** Agent parameters. Defaults to {} when TParams is Record<string, unknown>. */
  params: TParams;
  paramsSchema?: ZodType<TParams>;
  layers?: MemoryLayer[];
  tools?: Tool[];
  llm?: {
    provider: 'openrouter';
    apiKey: string;
    model?: string;
  };
  debugger?: DebuggerConfig;
  exporterOptions?: ExporterOptions;
  traceExporter?: TraceExporter;
}

//#endregion

//#region DebugAgentHarness

export class DebugAgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>> {
  private baseHarness: AgentHarness<TParams>;
  private debugger_: Debugger | null = null;
  private exporter: NoeticUITraceExporter | null = null;
  private debugConfig: DebuggerConfig;

  constructor(config: DebugHarnessConfig<TParams>) {
    this.exporter = config.traceExporter
      ? null
      : new NoeticUITraceExporter(
          config.exporterOptions ?? {
            port: 3333,
          },
        );

    this.baseHarness = new AgentHarness<TParams>({
      name: config.name,
      initialStep: config.initialStep,
      params: config.params,
      paramsSchema: config.paramsSchema,
      traceExporter: config.traceExporter ?? this.exporter ?? undefined,
    });

    this.debugConfig = config.debugger ?? {};

    if (Object.keys(this.debugConfig).length > 0 || process.env.NOETIC_UI_ENABLED) {
      this.setupDebugger();
    }
  }

  async execute(input: ExecuteInput, options?: ExecuteOptions): Promise<string> {
    const runId = crypto.randomUUID();
    const agentId = this.baseHarness.config.name;

    const inputData =
      typeof input === 'string'
        ? input
        : Array.isArray(input)
          ? input
          : [
              input,
            ];

    if (this.exporter) {
      this.exporter.sendEvent({
        type: 'agent.register',
        agentId,
        agentName: this.baseHarness.config.name,
        timestamp: Date.now(),
      });
    }

    if (this.debugger_) {
      globalHookManager.onRunStart(agentId, runId, inputData);
    }

    try {
      const result = await this.baseHarness.execute(input, options);

      if (this.debugger_) {
        globalHookManager.onRunComplete('completed');
      }

      // Signal trace completion so the exporter sends trace.complete
      this.exporter?.completeAllTraces();

      return await result.getText();
    } catch (error) {
      if (this.debugger_) {
        globalHookManager.onRunComplete('error');
      }
      this.exporter?.completeAllTraces();
      throw error;
    }
  }

  /**
   * Run a step with debugging hooks.
   * Delegates to the base harness for actual execution and type inference.
   */
  async run<I, O>(step: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O> {
    if (this.debugger_?.isAttached) {
      // Hooks accept StepMeta (just id + kind), which Step<M,I,O> satisfies
      await globalHookManager.onStepStart(step, input, ctx);

      try {
        const result = await this.baseHarness.run(step, input, ctx);
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

    return this.baseHarness.run(step, input, ctx);
  }

  get harness(): AgentHarness<TParams> {
    return this.baseHarness;
  }

  get debugger(): DebugController | null {
    return this.debugger_;
  }

  get isDebugging(): boolean {
    return this.debugger_?.isAttached ?? false;
  }

  pause(): void {
    this.debugger_?.pause();
  }

  resume(): void {
    this.debugger_?.resume();
  }

  stepOver(): void {
    this.debugger_?.stepOver();
  }

  stepInto(): void {
    this.debugger_?.stepInto();
  }

  stepOut(): void {
    this.debugger_?.stepOut();
  }

  addBreakpoint(breakpoint: Breakpoint | string): void {
    const normalized =
      typeof breakpoint === 'string'
        ? {
            stepId: breakpoint,
          }
        : breakpoint;
    this.debugger_?.addBreakpoint(normalized);
  }

  removeBreakpoint(stepId: string): void {
    this.debugger_?.removeBreakpoint(stepId);
  }

  close(): void {
    this.exporter?.close();
    globalHookManager.detachDebugger();
  }

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
    this.debugger_ = new Debugger(
      this.debugConfig,
      this.exporter ? (msg) => this.exporter?.sendEvent(msg) : undefined,
    );
    globalHookManager.attachDebugger(this.debugger_);
  }
}

//#endregion

//#region Factory Functions

export function createDebugHarness<
  TParams extends Record<string, unknown> = Record<string, unknown>,
>(config: DebugHarnessConfig<TParams>): DebugAgentHarness<TParams> {
  return new DebugAgentHarness(config);
}

export function shouldEnableDebug(config?: DebugHarnessConfig): boolean {
  return !!(process.env.NOETIC_UI_ENABLED || config?.debugger || config?.exporterOptions);
}

//#endregion
