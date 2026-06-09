/**
 * Prompt engineering memory layer — sophisticated behavioral guidelines.
 *
 * Provides dynamic context-aware instructions based on Claude Code's
 * prompt engineering patterns. Adapts based on tool usage patterns,
 * recent errors, and conversation context.
 */

import type { FunctionCallItem, FunctionCallOutputItem, Item, MemoryLayer } from '@noetic/core';
import { Slot } from '@noetic/core';

//#region Types

interface PromptEngineeringState {
  currentMode: 'normal' | 'planning';
  recentErrors: Array<{
    tool: string;
    error: string;
    timestamp: number;
  }>;
  toolUsagePatterns: Record<string, number>;
  lastContextUpdate: number;
}

//#endregion

//#region Type Guards

function isFunctionCall(item: Item): item is FunctionCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call' &&
    'name' in item
  );
}

function isFailedToolResult(item: Item): item is FunctionCallOutputItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    item.type === 'function_call_output' &&
    item.status === 'failed'
  );
}

//#endregion

//#region Helpers

function createInitialState(): PromptEngineeringState {
  return {
    currentMode: 'normal',
    recentErrors: [],
    toolUsagePatterns: {},
    lastContextUpdate: Date.now(),
  };
}

function getCoreBehavioralGuidelines(): string {
  return `# Core Behavioral Guidelines

## Communication Efficiency
- Lead with answers, not process description
- Use 1 sentence instead of 3 when possible
- Focus on user-facing decisions, not internal steps
- Skip filler words, preamble, and unnecessary transitions

## Focus Areas
Prioritize communication about:
- Decisions requiring user input
- High-level status updates at natural milestones
- Errors or blockers that change the plan
Avoid: step-by-step narration, routine operations`;
}

function getToolUsageGuidelines(patterns: Record<string, number>): string {
  const mostUsedTools = Object.entries(patterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  if (mostUsedTools.length === 0) {
    return '';
  }

  return `## Recent Tool Usage Patterns
Frequently used: ${mostUsedTools.join(', ')}

### Tool Usage Reminders
- Use dedicated tools over generic bash commands when available
- Read files before editing them (Edit tool requirement)
- Use parallel tool calls for independent operations
- Reserve bash for system commands requiring shell execution`;
}

function getErrorBasedGuidance(
  errors: Array<{
    tool: string;
    error: string;
    timestamp: number;
  }>,
): string {
  if (errors.length === 0) {
    return '';
  }

  const recentErrors = errors.filter((e) => Date.now() - e.timestamp < 300000); // Last 5 minutes
  if (recentErrors.length === 0) {
    return '';
  }

  const errorsByTool: Record<string, number> = {};
  for (const err of recentErrors) {
    errorsByTool[err.tool] = (errorsByTool[err.tool] || 0) + 1;
  }

  return `## Recent Error Context
Tools with issues: ${Object.keys(errorsByTool).join(', ')}

### Error Recovery Reminders
- If tool calls fail due to restrictions, understand why before retrying
- Don't bypass mechanisms without understanding the constraint
- Escalate to user when genuinely stuck after investigation`;
}

function detectErrors(items: ReadonlyArray<Item>): Array<{
  tool: string;
  error: string;
  timestamp: number;
}> {
  const errors: Array<{
    tool: string;
    error: string;
    timestamp: number;
  }> = [];

  for (let i = 0; i < items.length - 1; i++) {
    const item = items[i];
    const nextItem = items[i + 1];

    if (isFunctionCall(item) && isFailedToolResult(nextItem)) {
      errors.push({
        tool: item.name,
        error: nextItem.output.substring(0, 200), // First 200 chars
        timestamp: Date.now(),
      });
    }
  }

  return errors;
}

//#endregion

//#region Public API

export function promptEngineeringLayer(): MemoryLayer<PromptEngineeringState> {
  return {
    id: 'prompt-engineering',
    name: 'Prompt Engineering',
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 200,
      max: 1000,
    },

    hooks: {
      async init() {
        return {
          state: createInitialState(),
        };
      },

      async recall({ state }) {
        const guidelines: string[] = [];

        // Always include core behavioral guidelines
        guidelines.push(getCoreBehavioralGuidelines());

        // Add tool-specific guidance based on usage patterns
        const toolGuidance = getToolUsageGuidelines(state.toolUsagePatterns);
        if (toolGuidance) {
          guidelines.push(toolGuidance);
        }

        // Add error-based learning if there are recent errors
        const errorGuidance = getErrorBasedGuidance(state.recentErrors);
        if (errorGuidance) {
          guidelines.push(errorGuidance);
        }

        return guidelines.join('\n\n');
      },

      async store({ newItems, state }) {
        // Track tool usage patterns
        const newPatterns: Record<string, number> = {
          ...state.toolUsagePatterns,
        };

        // Update tool usage counts
        for (const item of newItems) {
          if (isFunctionCall(item)) {
            newPatterns[item.name] = (newPatterns[item.name] || 0) + 1;
          }
        }

        // Detect and track errors
        const newErrors = [
          ...state.recentErrors,
          ...detectErrors(newItems),
        ].slice(-10); // Keep last 10 errors

        return {
          state: {
            ...state,
            toolUsagePatterns: newPatterns,
            recentErrors: newErrors,
            lastContextUpdate: Date.now(),
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit tool patterns but start with fresh errors
        return {
          childState: {
            ...parentState,
            recentErrors: [], // Fresh error context for spawned agents
            toolUsagePatterns: {
              ...parentState.toolUsagePatterns,
            },
          },
        };
      },
    },
  };
}

//#endregion
