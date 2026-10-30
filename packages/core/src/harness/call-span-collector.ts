import type { AgentHarnessContract, RoundUsage, Span, TraceExporter } from '@noetic-tools/types';
import { GenAI, NoeticAttr, ToolAttr } from '../observability/genai-attributes';
import type { ApprovalOutcome } from '../runtime/tool-approval';
import { exportSpans } from './deps/context';

//#region Call span collector

/**
 * Per-`callModel` span accumulator. Spans are created lazily from the calling
 * context's span (so the trace tree mirrors the execution tree) and flushed to
 * the harness `traceExporter` once the call settles — see issue #50, where the
 * exporter was stored but never invoked.
 */
export class CallSpanCollector {
  private readonly spans: Span[] = [];

  constructor(
    private readonly harness: AgentHarnessContract,
    private readonly exporter: TraceExporter,
    private readonly parent: Span | null,
    private readonly nodeId: string | undefined,
    /** Stamped on the first model span only, then dropped. */
    private firstSpanAttributes: Record<string, string | number | boolean> | undefined,
  ) {}

  /** Link a span back to its declared workflow node, when the call carries one. */
  private stampNode(span: Span): void {
    if (this.nodeId !== undefined) {
      span.setAttribute(NoeticAttr.NODE_ID, this.nodeId);
    }
  }

  /** Open a model-call span stamped with GenAI semantic-convention attributes. */
  startModelSpan(model: string): Span {
    const span = this.harness.createSpan('llm.call', this.parent);
    span.setAttribute(GenAI.SYSTEM, 'openrouter');
    span.setAttribute(GenAI.REQUEST_MODEL, model);
    this.stampNode(span);
    for (const [key, value] of Object.entries(this.firstSpanAttributes ?? {})) {
      span.setAttribute(key, value);
    }
    this.firstSpanAttributes = undefined;
    this.spans.push(span);
    return span;
  }

  /** Record usage + cost on a model-call span. */
  finishModelSpan(span: Span, usage: RoundUsage, cost: number | undefined): void {
    span.setAttribute(GenAI.USAGE_INPUT_TOKENS, usage.inputTokens);
    span.setAttribute(GenAI.USAGE_OUTPUT_TOKENS, usage.outputTokens);
    if (usage.cachedTokens !== undefined) {
      span.setAttribute(GenAI.USAGE_CACHED_INPUT_TOKENS, usage.cachedTokens);
    }
    if (usage.cacheWriteTokens !== undefined) {
      span.setAttribute(GenAI.USAGE_CACHE_WRITE_TOKENS, usage.cacheWriteTokens);
    }
    if (cost !== undefined) {
      span.setAttribute(GenAI.COST, cost);
    }
    span.end();
  }

  /** Open and immediately close a tool-call span under the given model span. */
  recordToolSpan(
    parent: Span,
    toolName: string,
    needsApproval: boolean,
    approval: ApprovalOutcome | undefined,
  ): void {
    const span = this.harness.createSpan('tool.call', parent);
    span.setAttribute(ToolAttr.NAME, toolName);
    span.setAttribute(ToolAttr.NEEDS_APPROVAL, needsApproval);
    if (approval !== undefined) {
      span.setAttribute(ToolAttr.APPROVAL, approval);
    }
    this.stampNode(span);
    span.end();
    this.spans.push(span);
  }

  /** Flush all accumulated spans to the exporter. */
  async flush(): Promise<void> {
    if (this.spans.length === 0) {
      return;
    }
    await exportSpans(this.exporter, this.spans);
  }
}

//#endregion
