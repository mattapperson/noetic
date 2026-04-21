/**
 * Tool guidance memory layer — dynamic tool usage instructions.
 *
 * Provides context-aware tool usage guidance based on available tools,
 * current mode, and recent usage patterns. Adapts instructions based
 * on Claude Code's sophisticated tool preference patterns.
 */

import type { MemoryLayer, Tool } from '@noetic/core';
import { Slot } from '@noetic/core';

//#region Types

interface ToolGuidanceState {
  availableTools: string[];
  currentMode: 'normal' | 'planning';
  recentToolFailures: Array<{ tool: string; reason: string; timestamp: number }>;
}

interface ToolGuidanceConfig {
  tools: ReadonlyArray<Tool>;
  mode?: 'normal' | 'planning';
}

//#endregion

//#region Helpers

function createInitialState(tools: ReadonlyArray<Tool>, mode: 'normal' | 'planning' = 'normal'): ToolGuidanceState {
  return {
    availableTools: tools.map(t => t.name),
    currentMode: mode,
    recentToolFailures: [],
  };
}

function getFileOperationGuidance(toolNames: string[]): string {
  const hasRead = toolNames.includes('Read');
  const hasEdit = toolNames.includes('Edit');
  const hasWrite = toolNames.includes('Write');
  
  if (!hasRead && !hasEdit && !hasWrite) {
    return '';
  }

  return `## File Operations Guidelines
${hasRead && hasEdit ? '- ALWAYS read files before editing them (Edit tool will error otherwise)' : ''}
${hasEdit ? '- Preserve exact indentation as shown after line numbers' : ''}
${hasEdit ? '- Use unique context strings for replacements (Edit tool requires unique old_string)' : ''}
${hasWrite && hasEdit ? '- Prefer editing existing files over creating new ones' : ''}
${hasRead ? '- File paths must be absolute, not relative' : ''}

### Format Requirements for Edit Tool:
${hasEdit ? `- Line prefix format: [number][tab][content]
- Never include line numbers in old_string/new_string
- Ensure old_string is unique within the file` : ''}`;
}

function getToolPreferenceHierarchy(toolNames: string[]): string {
  const preferences: string[] = [];
  
  if (toolNames.includes('Read')) {
    preferences.push('File reading: Use Read tool (NOT cat/head/tail)');
  }
  if (toolNames.includes('Edit')) {
    preferences.push('File editing: Use Edit tool (NOT sed/awk)');
  }
  if (toolNames.includes('Write')) {
    preferences.push('File creation: Use Write tool (NOT echo >/cat <<EOF)');
  }
  if (toolNames.includes('Find')) {
    preferences.push('File search: Use Find tool (NOT find command)');
  }
  if (toolNames.includes('Grep')) {
    preferences.push('Content search: Use Grep tool (NOT grep/rg)');
  }
  if (toolNames.includes('Bash')) {
    preferences.push('Shell operations: Reserve Bash for system commands requiring shell execution');
  }
  
  if (preferences.length === 0) {
    return '';
  }

  return `## Tool Usage Hierarchy
NEVER use generic tools when specific ones exist:
${preferences.map(p => `- ${p}`).join('\n')}

### Tool Integration Guidelines
- Call multiple independent tools in parallel when possible
- Use sequential calls only when tools have dependencies
- If a tool fails due to restrictions, understand why before retrying`;
}

function getPlanModeGuidance(toolNames: string[]): string {
  const readOnlyTools = toolNames.filter(name => 
    ['Read', 'Grep', 'Find', 'Bash'].includes(name) || name.startsWith('plan/')
  );
  
  const restrictedTools = toolNames.filter(name => 
    ['Write', 'Edit'].includes(name)
  );

  return `## Plan Mode Tool Usage
**Available for exploration:** ${readOnlyTools.join(', ')}
${restrictedTools.length > 0 ? `**Restricted:** ${restrictedTools.join(', ')} (read-only mode)` : ''}

### Plan Mode Objectives:
- Understand codebase structure and requirements
- Author comprehensive PRDs in plan.md files
- Design FlowSchema execution trees using plan/setPlanTree
- Prepare for implementation phase

### FlowSchema Node Types:
- **llm**: Direct LLM processing tasks
- **subagent**: Delegate to specialized agents
- **fork**: Parallel execution branches  
- **spawn**: Independent task creation
- **sequence**: Sequential task chains

Use plan/updatePrd to modify plan.md files with structured PRDs.
Use plan/setPlanTree to update execution plans with FlowSchema nodes.`;
}

function getAgentDelegationGuidance(toolNames: string[]): string {
  const hasAgentTools = toolNames.some(name => 
    ['spawn', 'subagent', 'Agent'].includes(name)
  );
  
  if (!hasAgentTools) {
    return '';
  }

  return `## Agent Delegation Guidelines

### When to Delegate:
- Complex multi-step tasks requiring specialized knowledge
- Research that would clutter your context window
- Parallel work streams (testing while implementing)
- Tasks requiring different tool access patterns

### When NOT to Delegate:
- Simple file reads (use Read tool directly)
- Specific searches (use Find/Grep directly)  
- Tasks requiring your current conversation context
- Single-step operations

### Delegation Best Practices:
- Brief agents like colleagues joining mid-task
- Provide complete context, not just instructions
- Include file paths and specifics, not vague directions
- Use background agents for independent work
- Use foreground agents when you need results to proceed

### Writing Agent Prompts:
- Explain what you're trying to accomplish and why
- Describe what you've already learned or ruled out
- Give enough context for the agent to make judgment calls
- Include specific requirements and constraints`;
}

function getToolFailureGuidance(failures: Array<{ tool: string; reason: string; timestamp: number }>): string {
  if (failures.length === 0) {
    return '';
  }

  const recentFailures = failures.filter(f => Date.now() - f.timestamp < 300000); // Last 5 minutes
  if (recentFailures.length === 0) {
    return '';
  }

  const failuresByTool = recentFailures.reduce((acc, failure) => {
    acc[failure.tool] = (acc[failure.tool] || []).concat(failure.reason);
    return acc;
  }, {} as Record<string, string[]>);

  const toolEntries = Object.entries(failuresByTool).map(([tool, reasons]) => 
    `- ${tool}: ${reasons[0]}` // Show most recent reason
  );

  return `## Recent Tool Issues
${toolEntries.join('\n')}

### Troubleshooting Reminders:
- Check file paths are absolute, not relative
- Verify permissions for file operations
- Ensure required tools are available in current mode
- Read error messages carefully for specific constraints`;
}

//#endregion

//#region Public API

export function toolGuidanceLayer(config: ToolGuidanceConfig): MemoryLayer<ToolGuidanceState> {
  const { tools, mode = 'normal' } = config;
  
  return {
    id: 'tool-guidance',
    name: 'Tool Guidance', 
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 300,
      max: 1200,
    },
    
    hooks: {
      async init() {
        return {
          state: createInitialState(tools, mode),
        };
      },
      
      async recall({ state }) {
        const toolNames = state.availableTools;
        const guidance: string[] = [];
        
        // Core tool preference hierarchy
        const preferences = getToolPreferenceHierarchy(toolNames);
        if (preferences) {
          guidance.push(preferences);
        }
        
        // File operation specific guidance
        const fileOps = getFileOperationGuidance(toolNames);
        if (fileOps) {
          guidance.push(fileOps);
        }
        
        // Mode-specific guidance
        if (state.currentMode === 'planning') {
          guidance.push(getPlanModeGuidance(toolNames));
        }
        
        // Agent delegation guidance (if applicable)
        const agentGuidance = getAgentDelegationGuidance(toolNames);
        if (agentGuidance) {
          guidance.push(agentGuidance);
        }
        
        // Tool failure recovery guidance
        const failureGuidance = getToolFailureGuidance(state.recentToolFailures);
        if (failureGuidance) {
          guidance.push(failureGuidance);
        }
        
        if (guidance.length === 0) {
          return null;
        }
        
        return `# Tool Usage Guidelines\n\n${guidance.join('\n\n')}`;
      },

      async store({ newItems, state }) {
        // Track tool failures for adaptive guidance
        // This is a simplified implementation - in practice you'd parse tool results
        // to detect failures and their reasons
        
        // For now, just return current state
        // In a full implementation, you'd detect tool failures and update recentToolFailures
        
        return {
          state: {
            ...state,
            // Tool failure detection would go here
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit tool availability and mode but start with fresh failure history
        return {
          childState: {
            ...parentState,
            recentToolFailures: [], // Fresh failure context for spawned agents
          },
        };
      },
    },
  };
}

//#endregion