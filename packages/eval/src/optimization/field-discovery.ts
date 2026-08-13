import type { Step } from '@noetic-tools/core';
import { isServerToolSpec } from '@noetic-tools/core';

import { OptimizeScope } from '../types/eval';
import type { OptimizableField } from '../types/optimizer';
import { FieldKind } from '../types/optimizer';

//#region Types

type ScopeValue = (typeof OptimizeScope)[keyof typeof OptimizeScope];
type FieldKindValue = (typeof FieldKind)[keyof typeof FieldKind];

//#endregion

//#region Constants

const SCOPE_ALLOWED_KINDS: Record<ScopeValue, ReadonlySet<FieldKindValue>> = {
  [OptimizeScope.PromptsOnly]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
  ]),
  [OptimizeScope.FlowStructure]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
  [OptimizeScope.Full]: new Set([
    FieldKind.Instructions,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
};

//#endregion

//#region Helper Functions

function extractCallModelFields(
  step: Step & {
    kind: 'callModel';
  },
  path: string,
  fields: OptimizableField[],
): void {
  // Function-form Lazy<T> fields resolve at execution time against a live
  // context; they cannot be optimized by static candidate substitution.
  if (typeof step.instructions === 'string') {
    fields.push({
      path: `${path}.instructions`,
      value: step.instructions,
      stepId: step.id,
      fieldKind: FieldKind.Instructions,
    });
  }
  if (!Array.isArray(step.tools)) {
    return;
  }
  for (const t of step.tools) {
    // Server tools (web_search/web_fetch) carry no optimizable name/description.
    if (isServerToolSpec(t)) {
      continue;
    }
    fields.push({
      path: `${path}.tools.${t.name}.description`,
      value: t.description,
      stepId: step.id,
      fieldKind: FieldKind.ToolDescription,
    });
    fields.push({
      path: `${path}.tools.${t.name}.name`,
      value: t.name,
      stepId: step.id,
      fieldKind: FieldKind.ToolName,
    });
  }
}

function extractInvokeToolFields(
  step: Step & {
    kind: 'invokeTool';
  },
  path: string,
  fields: OptimizableField[],
): void {
  fields.push({
    path: `${path}.tool.description`,
    value: step.tool.description,
    stepId: step.id,
    fieldKind: FieldKind.ToolDescription,
  });
  fields.push({
    path: `${path}.tool.name`,
    value: step.tool.name,
    stepId: step.id,
    fieldKind: FieldKind.ToolName,
  });
}

function walkOptimizableChildren(
  optimizable: Step[] | undefined,
  path: string,
  fields: OptimizableField[],
): void {
  if (!optimizable) {
    return;
  }
  for (const child of optimizable) {
    walkStep(child, `${path}.`, fields);
  }
}

function walkStep(step: Step, prefix: string, fields: OptimizableField[]): void {
  const path = `${prefix}${step.id}`;

  switch (step.kind) {
    case 'callModel':
      extractCallModelFields(step, path, fields);
      return;
    case 'invokeTool':
      extractInvokeToolFields(step, path, fields);
      return;
    case 'spawn':
      walkStep(step.child, `${path}.`, fields);
      return;
    case 'loop':
      for (const s of step.steps) {
        walkStep(s, `${path}.`, fields);
      }
      return;
    case 'withContext':
      walkStep(step.child, `${path}.`, fields);
      return;
    case 'schedule':
      walkStep(step.step, `${path}.`, fields);
      return;
    case 'conditional':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    case 'inParallel':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    case 'runCode':
      return;
    // An ACP agent step carries its prompt as Lazy<string> — an eager form
    // could in principle be discovered, but the mutator does not model that
    // surface, so surfacing fields here would produce candidates no mutator can
    // apply. Contribute nothing, matching `applyCandidate`'s pass-through.
    case 'acp-agent':
      return;
    default: {
      // A new composite Step kind must add a recursion case above, or GEPA
      // silently discovers zero fields for agents rooted in it.
      const _exhaustive: never = step;
      void _exhaustive;
      return;
    }
  }
}

function filterByScope(fields: OptimizableField[], scope: ScopeValue): OptimizableField[] {
  const allowed = SCOPE_ALLOWED_KINDS[scope];
  return fields.filter((f) => allowed.has(f.fieldKind));
}

//#endregion

//#region Public API

export function discoverFields(
  step: Step,
  prefix?: string,
  scope?: ScopeValue,
): OptimizableField[] {
  const fields: OptimizableField[] = [];
  const pathPrefix = prefix ? `${prefix}.` : '';
  walkStep(step, pathPrefix, fields);

  if (!scope) {
    return fields;
  }
  return filterByScope(fields, scope);
}

export function enrichWithSourceLocations(
  runtimeFields: OptimizableField[],
  astFields: OptimizableField[],
): OptimizableField[] {
  const astIndex = new Map<string, OptimizableField[]>();
  for (const af of astFields) {
    if (!af.sourceLocation) {
      continue;
    }
    const key = `${af.stepId}:${af.fieldKind}:${af.value}`;
    const existing = astIndex.get(key) ?? [];
    existing.push(af);
    astIndex.set(key, existing);
  }

  const consumed = new Set<OptimizableField>();

  return runtimeFields.map((rf) => {
    const candidates = astIndex.get(`${rf.stepId}:${rf.fieldKind}:${rf.value}`);
    if (!candidates) {
      return rf;
    }
    const match = candidates.find((c) => !consumed.has(c));
    if (!match?.sourceLocation) {
      return rf;
    }
    consumed.add(match);
    return {
      ...rf,
      sourceLocation: match.sourceLocation,
    };
  });
}

//#endregion
