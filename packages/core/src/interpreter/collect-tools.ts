import type { Step, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

/**
 * Recursively walks a step tree and collects all Tool instances
 * declared on LLM steps. Used to build the unified tool set
 * that gets sent with every LLM call for prompt cache efficiency.
 */
export function collectAllTools<TMemory = unknown, I = unknown, O = unknown>(
  step: Step<TMemory, I, O>,
): Tool[] {
  const tools: Tool[] = [];
  // walkStep uses Step with defaults (unknown generics); the cast is safe because
  // we only read the `.tools`, `.child`, `.steps`, `._optimizable` structural fields.
  walkStep(frameworkCast<Step>(step), tools);
  return deduplicateTools(tools);
}

/**
 * Deduplicates tools by name, keeping the first occurrence.
 */
export function deduplicateTools(tools: ReadonlyArray<Tool>): Tool[] {
  const seen = new Map<string, Tool>();
  for (const tool of tools) {
    if (!seen.has(tool.name)) {
      seen.set(tool.name, tool);
    }
  }
  return [
    ...seen.values(),
  ];
}

function walkStep(step: Step, out: Tool[]): void {
  switch (step.kind) {
    case 'llm':
      // Skip function-form tools: they're resolved per execution from `ctx`
      // and cannot contribute to the pre-computed unified set. Consumers that
      // need those tools in the pool should register them via
      // `AgentHarness.tools` instead.
      if (Array.isArray(step.tools)) {
        out.push(...step.tools);
      }
      return;

    case 'run':
    case 'tool':
      return;

    case 'branch':
      if (step._optimizable) {
        for (const child of step._optimizable) {
          walkStep(child, out);
        }
      }
      return;

    case 'fork':
      if (step._optimizable) {
        for (const child of step._optimizable) {
          walkStep(child, out);
        }
      }
      return;

    case 'provide':
      walkStep(step.child, out);
      return;

    case 'spawn':
      walkStep(step.child, out);
      return;

    case 'loop':
      for (const child of step.steps) {
        walkStep(child, out);
      }
      return;

    case 'every':
      walkStep(step.step, out);
      return;

    default:
      step satisfies never;
      return;
  }
}
