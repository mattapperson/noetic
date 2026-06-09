/**
 * Planning mode memory layer — specialized instructions for plan mode.
 *
 * Provides enhanced guidance when operating in planning mode, including
 * FlowSchema patterns, PRD authoring guidelines, and read-only tool usage.
 */

import type { FunctionCallItem, Item, MemoryLayer, Tool } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';

//#region Types

interface PlanningModeState {
  isActive: boolean;
  planningPhase: 'exploration' | 'authoring' | 'review';
  activePRDs: string[];
  flowSchemaNodes: Array<{
    type: string;
    description: string;
  }>;
  explorationProgress: {
    filesExamined: number;
  };
}

interface PlanningModeConfig {
  availableTools: ReadonlyArray<Tool>;
  currentMode: 'normal' | 'planning';
}

//#endregion

//#region Helpers

function createInitialState(isActive: boolean): PlanningModeState {
  return {
    isActive,
    planningPhase: 'exploration',
    activePRDs: [],
    flowSchemaNodes: [],
    explorationProgress: {
      filesExamined: 0,
    },
  };
}

function isFunctionCall(item: Item): item is FunctionCallItem {
  return typeof item === 'object' && item !== null && item.type === 'function_call';
}

/** Mutable accumulator threaded through per-item progress updates. */
interface ExplorationAccumulator {
  filesExamined: number;
  activePRDs: string[];
  flowSchemaNodes: PlanningModeState['flowSchemaNodes'];
}

function hasStringName(value: unknown): value is {
  name: string;
} {
  return (
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
  );
}

/** Pull the PRD name out of a `plan/updatePrd` call's JSON arguments, if present. */
function parsePrdName(args: string): string | null {
  try {
    const parsed = JSON.parse(args);
    return hasStringName(parsed) ? parsed.name : null;
  } catch {
    // Unparseable arguments — caller falls back to a placeholder.
    return null;
  }
}

/** Apply a single `plan/updatePrd` call to the accumulator's PRD list. */
function recordPrd(acc: ExplorationAccumulator, call: FunctionCallItem): void {
  const name = parsePrdName(call.arguments);
  if (name === null) {
    if (acc.activePRDs.length === 0) {
      acc.activePRDs.push('plan.md');
    }
    return;
  }
  if (!acc.activePRDs.includes(name)) {
    acc.activePRDs.push(name);
  }
}

/** Per-tool handlers that update exploration progress from a function call. */
const PROGRESS_HANDLERS: Record<
  string,
  (acc: ExplorationAccumulator, call: FunctionCallItem) => void
> = {
  Read: (acc) => {
    acc.filesExamined += 1;
  },
  'plan/updatePrd': recordPrd,
  'plan/setPlanTree': (acc) => {
    acc.flowSchemaNodes.push({
      type: 'execution-tree',
      description: 'FlowSchema execution tree defined via plan/setPlanTree',
    });
  },
};

/** Fold new conversation items into an updated exploration accumulator. */
function accumulateProgress(
  newItems: ReadonlyArray<Item>,
  state: PlanningModeState,
): ExplorationAccumulator {
  const acc: ExplorationAccumulator = {
    filesExamined: state.explorationProgress.filesExamined,
    activePRDs: [
      ...state.activePRDs,
    ],
    flowSchemaNodes: [
      ...state.flowSchemaNodes,
    ],
  };
  for (const item of newItems) {
    if (!isFunctionCall(item)) {
      continue;
    }
    PROGRESS_HANDLERS[item.name]?.(acc, item);
  }
  return acc;
}

/** Advance the planning phase based on accumulated progress. */
function nextPhase(
  current: PlanningModeState['planningPhase'],
  acc: ExplorationAccumulator,
): PlanningModeState['planningPhase'] {
  if (current === 'exploration' && acc.filesExamined > 10) {
    return 'authoring';
  }
  if (current === 'authoring' && acc.activePRDs.length > 0) {
    return 'review';
  }
  return current;
}

function getFlowSchemaGuidelines(): string {
  return `## FlowSchema Node Types

When constructing execution plans, use these FlowSchema node types:

### Core Node Types:
- **llm**: Direct LLM processing tasks
  - Use for reasoning, analysis, and text generation
  - Example: "Analyze error logs and identify root cause"
  
- **subagent**: Delegate to specialized agents
  - Use when specialized expertise is needed
  - Agents inherit context but have focused capabilities
  - Example: "Use test-runner agent to validate changes"

- **fork**: Parallel execution branches
  - Use for independent work streams that can run concurrently
  - Forks share context and prompt cache
  - Example: "Fork implementation while continuing research"

- **spawn**: Independent task creation  
  - Use for completely separate tasks
  - Creates new context without parent inheritance
  - Example: "Spawn documentation update task"

- **sequence**: Sequential task chains
  - Use for ordered, dependent operations
  - Each step builds on previous results
  - Example: "Sequence: read → analyze → modify → test"

### Node Selection Guidelines:
- Choose **llm** for direct reasoning and text work
- Choose **subagent** when you need specialized tools or expertise
- Choose **fork** for parallel work that benefits from shared context
- Choose **spawn** for independent tasks that don't need current context
- Choose **sequence** when order of operations matters`;
}

function getPRDAuthoringGuidelines(): string {
  return `## PRD Authoring Best Practices

### Structure for plan.md files:
\`\`\`markdown
# Project Name

## Overview
Brief description of what this project accomplishes.

## Requirements
- Functional requirements (what it should do)
- Non-functional requirements (performance, reliability, etc.)
- Constraints and limitations

## Architecture
- High-level component overview
- Key interfaces and data flows
- Technology choices and rationale

## Implementation Strategy
- Phase breakdown and milestones
- Risk assessment and mitigation
- Resource requirements

## Success Criteria
- Measurable outcomes
- Testing strategy
- Acceptance criteria
\`\`\`

### PRD Quality Guidelines:
- **Be specific**: Include file paths, component names, exact requirements
- **Be comprehensive**: Address edge cases and error scenarios  
- **Be actionable**: Write so implementation can begin immediately
- **Be testable**: Include criteria for validation and testing

### Tools for PRD Management:
- Use \`plan/updatePrd\` to modify plan.md files
- Use \`plan/setPlanTree\` to define FlowSchema execution trees
- Use Read/Grep/Find tools for codebase exploration during authoring`;
}

function getPlanModeToolGuidance(availableTools: string[]): string {
  const readOnlyTools = availableTools.filter(
    (name) =>
      [
        'Read',
        'Grep',
        'Find',
        'Bash',
      ].includes(name) || name.startsWith('plan/'),
  );

  const restrictedTools = availableTools.filter((name) =>
    [
      'Write',
      'Edit',
    ].includes(name),
  );

  return `## Plan Mode Tool Usage

### Available Tools (Read-Only Mode):
${readOnlyTools.map((tool) => `- **${tool}**: ${getToolDescription(tool)}`).join('\n')}

### Restricted Tools:
${
  restrictedTools.length > 0
    ? `${restrictedTools.map((tool) => `- **${tool}**: Disabled in plan mode`).join('\n')}`
    : 'None - all planning tools are available'
}

### Tool Usage Strategy:
1. **Exploration Phase**: Use Read, Grep, Find extensively to understand codebase
2. **Analysis Phase**: Use Bash for non-mutating commands (git log, npm list, etc.)
3. **Authoring Phase**: Use plan/updatePrd to write comprehensive PRDs
4. **Tree Design Phase**: Use plan/setPlanTree to create execution plans

### Best Practices:
- Read configuration files and package.json early for context
- Use Grep to find existing patterns and conventions
- Use Find to discover project structure and key files
- Document findings in PRDs as you explore`;
}

function getToolDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    Read: 'Read file contents, supports images and PDFs',
    Grep: 'Search file contents with patterns',
    Find: 'Search for files by name/pattern',
    Bash: 'Execute read-only shell commands',
    'plan/updatePrd': 'Update plan.md PRD files',
    'plan/setPlanTree': 'Define FlowSchema execution trees',
  };

  return descriptions[toolName] || 'Tool for planning mode operations';
}

function getExplorationGuidance(progress: PlanningModeState['explorationProgress']): string {
  if (progress.filesExamined === 0) {
    return '';
  }

  const guidance = [
    '## Exploration Progress',
    `- **Files examined**: ${progress.filesExamined}`,
  ];

  guidance.push(`
### Next Steps Recommendations:
${progress.filesExamined < 5 ? '- Continue exploring key project files (package.json, README, main source files)' : ''}
${progress.filesExamined >= 5 ? '- Ready to begin PRD authoring with plan/updatePrd' : ''}`);

  return guidance.join('\n');
}

function getPhaseSpecificGuidance(phase: PlanningModeState['planningPhase']): string {
  switch (phase) {
    case 'exploration':
      return `## Current Phase: Exploration

### Objectives:
- Understand codebase structure and architecture
- Identify key components and dependencies  
- Discover existing patterns and conventions
- Gather requirements from code, docs, and tests

### Recommended Actions:
1. Read package.json and README for project overview
2. Explore src/ directory structure with Find tool
3. Use Grep to find key patterns and interfaces
4. Examine configuration files and build setup
5. Review existing tests for requirement insights`;

    case 'authoring':
      return `## Current Phase: PRD Authoring

### Objectives:
- Write comprehensive PRDs in plan.md files
- Document requirements, architecture, and strategy
- Create detailed implementation roadmaps
- Define success criteria and testing approach

### Recommended Actions:
1. Use plan/updatePrd to create/modify PRDs
2. Structure PRDs with clear sections (see PRD guidelines)
3. Include specific file paths and component references
4. Document both functional and non-functional requirements
5. Plan implementation phases and milestones`;

    case 'review':
      return `## Current Phase: Review & Refinement

### Objectives:
- Review PRDs for completeness and accuracy
- Design FlowSchema execution trees
- Validate implementation strategy
- Prepare for transition to normal mode

### Recommended Actions:
1. Review existing PRDs for gaps or inconsistencies
2. Use plan/setPlanTree to create execution plans
3. Validate FlowSchema nodes align with requirements
4. Ensure PRDs provide clear implementation guidance
5. Consider edge cases and error scenarios`;
  }
}

//#endregion

//#region Public API

export function planningModeLayer(config: PlanningModeConfig): MemoryLayer<PlanningModeState> {
  return {
    id: 'planning-mode',
    name: 'Planning Mode',
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 400,
      max: 1500,
    },

    hooks: {
      async init() {
        const isActive = config.currentMode === 'planning';
        return {
          state: createInitialState(isActive),
        };
      },

      async recall({ state }) {
        if (!state.isActive) {
          return null;
        }

        const sections: string[] = [];

        // Core planning mode guidance
        sections.push(`# Plan Mode Active

## Purpose and Scope
Plan mode is a read-only exploration phase for understanding codebases and authoring PRDs.
Focus on analysis, documentation, and planning rather than implementation.

## Mode Transition
- Currently in: **Planning Mode** (read-only exploration)
- Next phase: Normal Mode (full implementation access)
- Transition: Use \`/plan cancel\` when planning is complete`);

        // FlowSchema guidelines
        sections.push(getFlowSchemaGuidelines());

        // PRD authoring guidelines
        sections.push(getPRDAuthoringGuidelines());

        // Tool usage for planning mode
        const toolNames = config.availableTools.map((t) => t.name);
        sections.push(getPlanModeToolGuidance(toolNames));

        // Phase-specific guidance
        sections.push(getPhaseSpecificGuidance(state.planningPhase));

        // Progress-specific guidance
        sections.push(getExplorationGuidance(state.explorationProgress));

        return sections.join('\n\n');
      },

      async store({ newItems, state }) {
        if (!state.isActive) {
          return {
            state,
          };
        }

        // Track exploration progress based on tool usage, then advance phase.
        const acc = accumulateProgress(newItems, state);

        return {
          state: {
            ...state,
            planningPhase: nextPhase(state.planningPhase, acc),
            activePRDs: acc.activePRDs,
            flowSchemaNodes: acc.flowSchemaNodes,
            explorationProgress: {
              filesExamined: acc.filesExamined,
            },
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit planning state but start fresh on progress tracking
        return {
          childState: {
            ...parentState,
            activePRDs: [],
            flowSchemaNodes: [],
            explorationProgress: createInitialState(parentState.isActive).explorationProgress,
          },
        };
      },
    },
  };
}

//#endregion
