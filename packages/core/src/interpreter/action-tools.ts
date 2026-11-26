import type { StepToolEntry } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { SplitStepTools } from '../connections/step-tools';
import {
  checkLazyEntries,
  offeredTools,
  splitCeiling,
  splitStepTools,
  stepConnectionsOf,
  withOffered,
} from '../connections/step-tools';
import { resolveLayerTools } from './action-deps';
import type { Context, ContextConfig, ContextLayer, Tool } from './action-types';

interface ResolvedTools {
  tools: Tool[] | undefined;
  allowedToolNames: string[] | undefined;
}

/**
 * Resolves which tools to send and what restrictions to apply.
 *
 * When a unified tool set exists on the context (collected before execution),
 * every LLM call sends the full set and step.tools narrows via allowedToolNames.
 *
 * Semantics:
 *   step.tools = undefined → unrestricted (all tools, no allowedToolNames),
 *                            except the tools of connections only some step lists
 *                            (a document node's ceiling narrows its connections)
 *   step.tools = []        → no tools at all
 *   step.tools = [a, b]    → full set sent, restrict to a and b (a connection
 *                            entry or pick restricts to its connection's tools,
 *                            each cut to what it picks and sent in place)
 *
 * Fallback: when no unified set exists (e.g. harness.run() called directly),
 * merge step tools with layer tools as before.
 */
export function resolveToolsAndRestrictions(
  listed: SplitStepTools | undefined,
  layers: ContextLayer[] | undefined,
  ctx: Context,
): ResolvedTools {
  const stepTools = listed?.tools;
  // stepTools = [] → explicit opt-out
  if (listed && !listed.ceiling && listed.tools.length === 0 && listed.picks.length === 0) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }

  const unified = ctx.unifiedTools;
  if (unified && unified.length > 0) {
    const offered = offeredTools(unified, listed, stepConnectionsOf(ctx));
    return {
      tools: withOffered(unified, offered),
      allowedToolNames: offered?.map((t) => t.name),
    };
  }

  // Fallback: no unified set (direct harness.run() path)
  const layerTools = layers && layers.length > 0 ? resolveLayerTools(layers, ctx.harness, ctx) : [];
  if (layerTools.length === 0 && !stepTools) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }
  const merged = [
    ...(stepTools ?? []),
    ...layerTools,
  ];
  return {
    tools: merged.length > 0 ? merged : undefined,
    allowedToolNames: undefined,
  };
}

/**
 * Splits a step's resolved `tools`. Client tools and connection picks flow
 * through the unified-tool / allowedToolNames / steering machinery; server-tool
 * specs bypass it and are stamped onto the model request (`_serverTools`) for
 * the model caller to wrap via the SDK's `serverTool()`. `undefined`
 * (unrestricted) is preserved, so the `[] = opt-out` semantics stay intact.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when function-form tools return
 * a connection the turn never attached.
 */
export function splitResolvedTools(
  step: {
    readonly id: string;
    readonly tools?: unknown;
  },
  resolved: ReadonlyArray<StepToolEntry> | undefined,
  ctx: Context,
): SplitStepTools | undefined {
  if (resolved === undefined) {
    return splitCeiling(step);
  }
  if (typeof step.tools === 'function') {
    checkLazyEntries(step.id, resolved, stepConnectionsOf(ctx));
  }
  return splitStepTools(resolved);
}

export const MAX_STEERING_RETRIES = 3;

/**
 * Resolves a `Lazy<T>` step field. If the value is a function, it is invoked
 * with the current context; otherwise the value is returned as-is. Supports
 * both sync and async getters.
 *
 * Lazy fields let a step inspect `ctx.harness.config.params`, `ctx.unifiedTools`,
 * or context layer state to produce per-execution values (model, instructions,
 * tools) without baking them in at build time.
 */
export async function resolveLazy<T, TContext>(
  value: T | ((ctx: Context<TContext>) => T | Promise<T>),
  ctx: Context<TContext>,
): Promise<T> {
  if (typeof value !== 'function') {
    return value;
  }
  // The `function` narrowing collapses to `T & Function` when `T` itself can
  // be a function, so we defer to `frameworkCast` — the single sanctioned
  // unsafe coercion helper. Runtime check above guarantees safety.
  const getter = frameworkCast<(ctx: Context<TContext>) => T | Promise<T>>(value);
  return await getter(ctx);
}

export function isContextConfig(value: unknown): value is ContextConfig {
  return typeof value === 'object' && value !== null && 'layers' in value;
}
