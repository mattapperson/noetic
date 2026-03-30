import type { Step } from '@noetic/core';

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
    FieldKind.System,
    FieldKind.ToolDescription,
  ]),
  [OptimizeScope.FlowStructure]: new Set([
    FieldKind.System,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
  [OptimizeScope.Full]: new Set([
    FieldKind.System,
    FieldKind.ToolDescription,
    FieldKind.ToolName,
  ]),
};

//#endregion

//#region Helper Functions

function extractLlmFields(
  step: Step & {
    kind: 'llm';
  },
  path: string,
  fields: OptimizableField[],
): void {
  if (step.system) {
    fields.push({
      path: `${path}.system`,
      value: step.system,
      stepId: step.id,
      fieldKind: FieldKind.System,
    });
  }
  if (!step.tools) {
    return;
  }
  for (const t of step.tools) {
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

function extractToolFields(
  step: Step & {
    kind: 'tool';
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
    case 'llm':
      extractLlmFields(step, path, fields);
      return;
    case 'tool':
      extractToolFields(step, path, fields);
      return;
    case 'spawn':
      walkStep(step.child, `${path}.`, fields);
      return;
    case 'loop':
      for (const s of step.steps) {
        walkStep(s, `${path}.`, fields);
      }
      return;
    case 'branch':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    case 'fork':
      walkOptimizableChildren(step._optimizable, path, fields);
      return;
    case 'run':
      return;
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
