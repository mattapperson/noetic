/**
 * Demo script showing the enhanced prompt engineering system in action.
 * 
 * This demonstrates how the memory layers provide dynamic, context-aware
 * instructions that adapt based on usage patterns and environment.
 */

import { createAgentHarness } from '../src/harness/factory.js';
import { createLocalFsAdapter } from '@noetic/core';
import type { AgentConfig } from '../src/types/config.js';

// Example configuration
const demoConfig: AgentConfig = {
  model: 'anthropic/claude-3.5-sonnet',
  cwd: process.cwd(),
  apiKey: process.env.OPENROUTER_API_KEY || 'demo-key',
  maxTurns: 5,
  systemPrompt: 'You are a helpful coding assistant.',
};

async function demonstrateEnhancedPrompts() {
  console.log('🚀 Enhanced Prompt Engineering Demo\n');
  
  // Create harness with enhanced prompt layers
  const { harness, memoryLayers } = await createAgentHarness({
    config: demoConfig,
    plugins: [],
    fs: createLocalFsAdapter(),
    mode: 'normal', // Start in normal mode
  });

  console.log('📋 Memory Layers Active:');
  memoryLayers.forEach(layer => {
    console.log(`  - ${layer.name} (${layer.id})`);
    console.log(`    Slot: ${layer.slot}, Budget: ${layer.budget.min}-${layer.budget.max}`);
  });

  // Demonstrate layer content generation
  console.log('\n🧠 Sample Layer Outputs:\n');

  // Find and demonstrate specific layers
  const promptLayer = memoryLayers.find(l => l.id === 'prompt-engineering');
  const toolLayer = memoryLayers.find(l => l.id === 'tool-guidance');
  const commLayer = memoryLayers.find(l => l.id === 'communication-style');
  const envLayer = memoryLayers.find(l => l.id === 'environment-context');

  if (promptLayer) {
    console.log('📝 Prompt Engineering Layer:');
    try {
      const { state } = await promptLayer.hooks.init!({} as any);
      const content = await promptLayer.hooks.recall!({ state, ctx: {} as any });
      console.log(content?.substring(0, 200) + '...\n');
    } catch (error) {
      console.log('  (Layer initialization would occur during actual agent run)\n');
    }
  }

  if (envLayer) {
    console.log('🌍 Environment Context Layer:');
    console.log('  Detects: Platform, Git status, Node version, available commands');
    console.log('  Provides: Platform-specific guidance, capability awareness\n');
  }

  // Show mode switching capability
  console.log('🔄 Mode Switching Demo:\n');
  
  // Create planning mode harness
  const { memoryLayers: planLayers } = await createAgentHarness({
    config: demoConfig,
    plugins: [],
    fs: createLocalFsAdapter(),
    mode: 'planning', // Planning mode
  });

  console.log('📊 Planning Mode Layers Added:');
  const planLayer = planLayers.find(l => l.id === 'planning-mode');
  if (planLayer) {
    console.log(`  + ${planLayer.name} (${planLayer.id})`);
    console.log('    Provides: FlowSchema guidance, PRD authoring, read-only tool usage');
  }

  console.log('\n✨ Key Features Demonstrated:');
  console.log('  ✅ Dynamic layer activation based on mode');
  console.log('  ✅ Environment-aware context generation');
  console.log('  ✅ Tool-specific guidance with clear hierarchies');
  console.log('  ✅ Adaptive communication style management');
  console.log('  ✅ Budget-aware content with min/max token limits');
  console.log('  ✅ State management across conversation turns');
}

// Advanced usage patterns
async function demonstrateAdvancedPatterns() {
  console.log('\n🔬 Advanced Usage Patterns:\n');

  console.log('1. 📈 Adaptive Learning:');
  console.log('   - Tool usage patterns influence future guidance');
  console.log('   - Error patterns trigger specific reminders');
  console.log('   - Communication style adapts to user preferences');

  console.log('\n2. 🎯 Context Sensitivity:');
  console.log('   - Different layers activate based on available tools');
  console.log('   - Mode-specific instructions (planning vs normal)');
  console.log('   - Environment-specific command guidance');

  console.log('\n3. 🔗 Layer Inheritance:');
  console.log('   - Spawned agents inherit relevant context');
  console.log('   - Tool patterns carry forward to subagents');
  console.log('   - Fresh error context for independent tasks');

  console.log('\n4. ⚡ Performance Optimization:');
  console.log('   - Budget-aware content generation');
  console.log('   - Cached static sections when possible');
  console.log('   - Minimal recomputation of unchanged context');
}

// Comparison with Claude Code's approach
function compareWithClaudeCode() {
  console.log('\n📊 Comparison with Claude Code:\n');
  
  console.log('Claude Code Approach:');
  console.log('  ❌ Static prompt concatenation');
  console.log('  ❌ No learning or adaptation');
  console.log('  ❌ Full recomputation every turn');
  console.log('  ✅ Comprehensive behavioral guidelines');
  console.log('  ✅ Tool-specific instructions');

  console.log('\nNoetic Enhanced Approach:');
  console.log('  ✅ Dynamic memory layer system');
  console.log('  ✅ Learning and adaptation over time');
  console.log('  ✅ Budget-aware content management');
  console.log('  ✅ Comprehensive behavioral guidelines');
  console.log('  ✅ Tool-specific instructions');
  console.log('  ✅ State management and inheritance');
  console.log('  ✅ Modular enhancement capability');
}

// Main demo execution
async function runDemo() {
  try {
    await demonstrateEnhancedPrompts();
    await demonstrateAdvancedPatterns();
    compareWithClaudeCode();
    
    console.log('\n🎉 Enhanced Prompt Engineering Demo Complete!');
    console.log('\nTo see the system in action:');
    console.log('  1. Run the CLI with any agent configuration');
    console.log('  2. Try switching modes with `/plan` and `/plan cancel`');
    console.log('  3. Activate skills to see behavioral guidelines');
    console.log('  4. Observe how instructions adapt to your usage patterns');
  } catch (error) {
    console.error('Demo error:', error);
  }
}

// Export for use or run directly
export { demonstrateEnhancedPrompts, demonstrateAdvancedPatterns, compareWithClaudeCode };

// Run if called directly
if (import.meta.main) {
  runDemo();
}