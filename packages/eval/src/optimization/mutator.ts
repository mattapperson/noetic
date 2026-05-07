import type { Step, Tool } from '@noetic/core';

import type { Candidate } from '../types/optimizer';

//#region Helper Functions

function replaceToolListFields(tools: Tool[], candidate: Candidate, path: string): Tool[] {
  return tools.map((t) => {
    const name = candidate[`${path}.tools.${t.name}.name`] ?? t.name;
    const description = candidate[`${path}.tools.${t.name}.description`] ?? t.description;
    return {
      ...t,
      name,
      description,
    };
  });
}

function cloneOptimizableChildren(
  children: Step[] | undefined,
  candidate: Candidate,
  path: string,
): Step[] | undefined {
  if (!children) {
    return undefined;
  }
  return children.map((child) => cloneAndReplace(child, candidate, `${path}.`));
}

function cloneAndReplace(step: Step, candidate: Candidate, prefix: string): Step {
  const path = `${prefix}${step.id}`;

  switch (step.kind) {
    case 'llm': {
      // Only rewrite eager (string / array) forms. Function-form Lazy<T> fields
      // resolve at execution time against a live context, so optimizer candidate
      // substitution cannot apply to them — pass them through unchanged.
      const instructions = candidate[`${path}.instructions`] ?? step.instructions;
      const tools = Array.isArray(step.tools)
        ? replaceToolListFields(step.tools, candidate, path)
        : step.tools;
      return {
        ...step,
        instructions,
        tools,
      };
    }
    case 'tool': {
      const name = candidate[`${path}.tool.name`] ?? step.tool.name;
      const description = candidate[`${path}.tool.description`] ?? step.tool.description;
      return {
        ...step,
        tool: {
          ...step.tool,
          name,
          description,
        },
      };
    }
    case 'spawn':
      return {
        ...step,
        child: cloneAndReplace(step.child, candidate, `${path}.`),
      };
    case 'provide':
      return {
        ...step,
        child: cloneAndReplace(step.child, candidate, `${path}.`),
      };
    case 'loop':
      return {
        ...step,
        steps: step.steps.map((s) => cloneAndReplace(s, candidate, `${path}.`)),
      };
    case 'every':
      return {
        ...step,
        step: cloneAndReplace(step.step, candidate, `${path}.`),
      };
    case 'branch':
      return {
        ...step,
        _optimizable: cloneOptimizableChildren(step._optimizable, candidate, path),
      };
    case 'fork':
      return {
        ...step,
        _optimizable: cloneOptimizableChildren(step._optimizable, candidate, path),
      };
    case 'run':
      return {
        ...step,
      };
  }
}

//#endregion

//#region Public API

export function applyCandidate(step: Step, candidate: Candidate, prefix?: string): Step {
  const pathPrefix = prefix ? `${prefix}.` : '';
  return cloneAndReplace(step, candidate, pathPrefix);
}

//#endregion
