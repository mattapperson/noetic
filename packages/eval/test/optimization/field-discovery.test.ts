import { describe, expect, test } from 'bun:test';
import type { Step, Tool } from '@noetic/core';
import { branch, spawn, step } from '@noetic/core';
import { z } from 'zod';
import { discoverFields, enrichWithSourceLocations } from '../../src/optimization/field-discovery';
import { OptimizeScope } from '../../src/types/eval';
import type { OptimizableField } from '../../src/types/optimizer';
import { FieldKind } from '../../src/types/optimizer';

interface MockFieldOpts {
  stepId: string;
  fieldKind: OptimizableField['fieldKind'];
  value: string;
  sourceLocation?: OptimizableField['sourceLocation'];
}

function makeMockField(opts: MockFieldOpts): OptimizableField {
  return {
    path: `${opts.stepId}.${opts.fieldKind}`,
    value: opts.value,
    stepId: opts.stepId,
    fieldKind: opts.fieldKind,
    sourceLocation: opts.sourceLocation,
  };
}

function makeMockTool(name: string, description: string): Tool {
  return {
    name,
    description,
    input: z.unknown(),
    output: z.unknown(),
    execute: async () => 'result',
  };
}

describe('discoverFields', () => {
  test('finds system field in StepLLM', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      system: 'You are a helpful assistant.',
    });

    const fields = discoverFields(llmStep);

    expect(fields).toHaveLength(1);
    expect(fields[0].path).toBe('my-llm.system');
    expect(fields[0].value).toBe('You are a helpful assistant.');
    expect(fields[0].stepId).toBe('my-llm');
    expect(fields[0].fieldKind).toBe(FieldKind.System);
  });

  test('finds tool name and description in StepLLM with tools', () => {
    const llmStep: Step = {
      kind: 'llm',
      id: 'llm-with-tools',
      model: 'test-model',
      system: 'Be helpful',
      tools: [
        makeMockTool('search', 'Search the web'),
      ],
    };

    const fields = discoverFields(llmStep);

    expect(fields).toHaveLength(3);
    expect(fields[0].fieldKind).toBe(FieldKind.System);
    expect(fields[1].fieldKind).toBe(FieldKind.ToolDescription);
    expect(fields[1].value).toBe('Search the web');
    expect(fields[2].fieldKind).toBe(FieldKind.ToolName);
    expect(fields[2].value).toBe('search');
  });

  test('finds tool name and description in StepTool', () => {
    const toolStep: Step = {
      kind: 'tool',
      id: 'calc-step',
      tool: makeMockTool('calculator', 'Perform calculations'),
    };

    const fields = discoverFields(toolStep);

    expect(fields).toHaveLength(2);
    expect(fields[0].path).toBe('calc-step.tool.description');
    expect(fields[0].value).toBe('Perform calculations');
    expect(fields[0].fieldKind).toBe(FieldKind.ToolDescription);
    expect(fields[1].path).toBe('calc-step.tool.name');
    expect(fields[1].value).toBe('calculator');
    expect(fields[1].fieldKind).toBe(FieldKind.ToolName);
  });

  test('recurses into StepSpawn wrapping a StepLLM', () => {
    const llmStep = step.llm({
      id: 'inner-llm',
      model: 'test-model',
      system: 'Inner system prompt',
    });

    const spawnStep = spawn({
      id: 'outer-spawn',
      child: llmStep,
    });

    const fields = discoverFields(spawnStep);

    expect(fields).toHaveLength(1);
    expect(fields[0].path).toBe('outer-spawn.inner-llm.system');
    expect(fields[0].value).toBe('Inner system prompt');
  });

  test('finds fields in branch _optimizable children', () => {
    const llmStep = step.llm({
      id: 'branch-llm',
      model: 'test-model',
      system: 'Branch system',
    });

    const branchStep = branch({
      id: 'my-branch',
      route: () => null,
      _optimizable: [
        llmStep,
      ],
    });

    const fields = discoverFields(branchStep);

    expect(fields).toHaveLength(1);
    expect(fields[0].path).toBe('my-branch.branch-llm.system');
    expect(fields[0].value).toBe('Branch system');
  });

  test('returns empty array for StepRun', () => {
    const runStep = step.run({
      id: 'my-run',
      execute: async (input: unknown) => input,
    });

    const fields = discoverFields(runStep);

    expect(fields).toHaveLength(0);
  });

  test('returns empty array for StepLLM without system or tools', () => {
    const llmStep = step.llm({
      id: 'bare-llm',
      model: 'test-model',
    });

    const fields = discoverFields(llmStep);

    expect(fields).toHaveLength(0);
  });
});

describe('enrichWithSourceLocations', () => {
  test('copies sourceLocation from AST fields to matching runtime fields', () => {
    const location = {
      filePath: 'agent.ts',
      line: 10,
      column: 5,
    };
    const runtimeFields = [
      makeMockField({
        stepId: 'llm-1',
        fieldKind: FieldKind.System,
        value: 'Be helpful',
      }),
    ];
    const astFields = [
      makeMockField({
        stepId: 'llm-1',
        fieldKind: FieldKind.System,
        value: 'Be helpful',
        sourceLocation: location,
      }),
    ];

    const enriched = enrichWithSourceLocations(runtimeFields, astFields);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].sourceLocation).toEqual(location);
  });

  test('leaves runtime fields unchanged when no AST match exists', () => {
    const runtimeFields = [
      makeMockField({
        stepId: 'llm-1',
        fieldKind: FieldKind.System,
        value: 'Be helpful',
      }),
    ];
    const astFields = [
      makeMockField({
        stepId: 'llm-2',
        fieldKind: FieldKind.System,
        value: 'Different',
        sourceLocation: {
          filePath: 'other.ts',
          line: 1,
          column: 1,
        },
      }),
    ];

    const enriched = enrichWithSourceLocations(runtimeFields, astFields);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].sourceLocation).toBeUndefined();
  });

  test('matches by stepId + fieldKind + value composite key', () => {
    const location = {
      filePath: 'tools.ts',
      line: 5,
      column: 3,
    };
    const runtimeFields = [
      makeMockField({
        stepId: 'tool-a',
        fieldKind: FieldKind.ToolDescription,
        value: 'Search',
      }),
      makeMockField({
        stepId: 'tool-a',
        fieldKind: FieldKind.ToolName,
        value: 'search',
      }),
    ];
    const astFields = [
      makeMockField({
        stepId: 'tool-a',
        fieldKind: FieldKind.ToolName,
        value: 'search',
        sourceLocation: location,
      }),
    ];

    const enriched = enrichWithSourceLocations(runtimeFields, astFields);

    expect(enriched[0].sourceLocation).toBeUndefined();
    expect(enriched[1].sourceLocation).toEqual(location);
  });

  test('returns empty array when both inputs are empty', () => {
    const enriched = enrichWithSourceLocations([], []);
    expect(enriched).toHaveLength(0);
  });
});

describe('discoverFields scope filtering', () => {
  const llmStep: Step = {
    kind: 'llm',
    id: 'scoped-llm',
    model: 'test-model',
    system: 'You are helpful',
    tools: [
      makeMockTool('search', 'Search the web'),
    ],
  };

  function expectAllThreeKinds(fields: OptimizableField[]): void {
    const kinds = fields.map((f) => f.fieldKind);
    expect(kinds).toContain(FieldKind.System);
    expect(kinds).toContain(FieldKind.ToolDescription);
    expect(kinds).toContain(FieldKind.ToolName);
    expect(fields).toHaveLength(3);
  }

  test('scope prompts-only returns System and ToolDescription but not ToolName', () => {
    const fields = discoverFields(llmStep, undefined, OptimizeScope.PromptsOnly);

    const kinds = fields.map((f) => f.fieldKind);
    expect(kinds).toContain(FieldKind.System);
    expect(kinds).toContain(FieldKind.ToolDescription);
    expect(kinds).not.toContain(FieldKind.ToolName);
    expect(fields).toHaveLength(2);
  });

  test('scope flow-structure returns all three field kinds', () => {
    const fields = discoverFields(llmStep, undefined, OptimizeScope.FlowStructure);
    expectAllThreeKinds(fields);
  });

  test('scope full returns all three field kinds', () => {
    const fields = discoverFields(llmStep, undefined, OptimizeScope.Full);
    expectAllThreeKinds(fields);
  });

  test('scope undefined returns all fields without filtering', () => {
    const fields = discoverFields(llmStep, undefined, undefined);
    expectAllThreeKinds(fields);
  });
});
