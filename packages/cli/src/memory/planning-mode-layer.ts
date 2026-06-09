/**
 * Planning mode memory layer — specialized instructions for plan mode.
 *
 * Provides enhanced guidance when operating in planning mode, including
 * FlowSchema patterns, PRD authoring guidelines, and read-only tool usage.
 */

import type { MemoryLayer, Tool } from '@noetic/core';
import { Slot } from '@noetic/core';

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
    componentsIdentified: string[];
    requirementsGathered: string[];
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
      componentsIdentified: [],
      requirementsGathered: [],
    },
  };
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
  const guidance = [
    '## Exploration Progress',
  ];

  if (progress.filesExamined > 0) {
    guidance.push(`- **Files examined**: ${progress.filesExamined}`);
  }

  if (progress.componentsIdentified.length > 0) {
    guidance.push(`- **Components identified**: ${progress.componentsIdentified.join(', ')}`);
  }

  if (progress.requirementsGathered.length > 0) {
    guidance.push(`- **Requirements gathered**: ${progress.requirementsGathered.length} items`);
  }

  guidance.push(`
### Next Steps Recommendations:
${progress.filesExamined < 5 ? '- Continue exploring key project files (package.json, README, main source files)' : ''}
${progress.componentsIdentified.length < 3 ? '- Identify main components and their relationships' : ''}
${progress.requirementsGathered.length < 5 ? '- Gather functional and non-functional requirements' : ''}
${progress.filesExamined >= 5 && progress.componentsIdentified.length >= 3 ? '- Ready to begin PRD authoring with plan/updatePrd' : ''}`);

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

        // Track exploration progress based on tool usage
        let newFilesExamined = state.explorationProgress.filesExamined;
        const newComponents = [
          ...state.explorationProgress.componentsIdentified,
        ];
        const newRequirements = [
          ...state.explorationProgress.requirementsGathered,
        ];

        // Simple tracking - could be enhanced with actual tool result analysis
        for (const item of newItems) {
          if (
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            item.type === 'function_call'
          ) {
            if (item.name === 'Read') {
              newFilesExamined += 1;
            }
            // Could add more sophisticated progress tracking here
          }
        }

        // Determine phase based on progress
        let newPhase = state.planningPhase;
        if (state.planningPhase === 'exploration' && newFilesExamined > 10) {
          newPhase = 'authoring';
        } else if (state.planningPhase === 'authoring' && state.activePRDs.length > 0) {
          newPhase = 'review';
        }

        return {
          state: {
            ...state,
            planningPhase: newPhase,
            explorationProgress: {
              filesExamined: newFilesExamined,
              componentsIdentified: newComponents,
              requirementsGathered: newRequirements,
            },
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit planning state but start fresh on progress tracking
        return {
          childState: {
            ...parentState,
            explorationProgress: createInitialState(parentState.isActive).explorationProgress,
          },
        };
      },
    },
  };
}

//#endregion
