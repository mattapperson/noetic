---
name: prompt-optimization
description: Advanced prompt engineering patterns and optimization techniques
when-to-use: When building sophisticated AI systems or optimizing agent behaviors
model-invocable: true
user-invocable: false
---

# Prompt Optimization Skill

Advanced prompt engineering patterns and optimization techniques for building sophisticated AI agents.

## Core Principles

### 1. Adaptive Instruction Design
- **Dynamic Context**: Instructions that adapt based on conversation state and usage patterns
- **Budget Awareness**: Content that respects token limits and prioritizes high-impact guidance  
- **State Management**: Persistent learning across conversation turns
- **Inheritance Patterns**: How spawned agents inherit and modify parent context

### 2. Behavioral Pattern Library
- **Communication Efficiency**: Lead with answers, minimize filler, focus on user decisions
- **Tool Usage Hierarchy**: Clear preference orders with explicit alternatives to avoid
- **Error Recovery**: Learning from failures to provide adaptive guidance
- **Progress Reporting**: Focus on milestones and blockers, skip routine operations

### 3. Memory Layer Architecture  
- **Slot Organization**: Strategic placement of different instruction types
- **Budget Management**: Min/max token allocations for optimal context usage
- **Conditional Activation**: Layers that activate based on specific conditions
- **Composite Patterns**: Combining multiple layers with intelligent merging

## Advanced Patterns

### Adaptive Layer Creation
```typescript
// Example: Context-sensitive reminder system
const reminderLayer = createAdaptiveLayer({
  id: 'smart-reminders',
  generateContent: (state, context) => {
    // Generate contextual reminders based on recent patterns
    return buildReminderContent(state.recentPatterns, context.currentTask);
  },
  updateState: (state, newItems) => {
    // Learn from interaction patterns
    return analyzeAndUpdatePatterns(state, newItems);
  }
});
```

### Conditional Layer Patterns
```typescript
// Layer that only activates during specific phases
const conditionalLayer = createConditionalLayer(
  baseLayer,
  (context) => context.phase === 'implementation',
  'Conditional layer not active in current phase'
);
```

### Composite Layer Merging
```typescript
// Intelligent merging of multiple instruction sources
const compositeLayer = createCompositeLayer(
  'comprehensive-guidance',
  'Comprehensive Guidance',
  [behavioralLayer, toolLayer, contextLayer],
  intelligentContentMerger
);
```

## Optimization Techniques

### 1. Content Prioritization
- **High-Impact First**: Most important instructions appear early
- **Context Sensitivity**: Adjust content based on available tools and mode
- **Deduplication**: Remove redundant information across layers
- **Progressive Disclosure**: Reveal complexity as needed

### 2. Token Efficiency
- **Structured Formatting**: Use consistent markdown patterns for parsing
- **Keyword Optimization**: Strategic use of high-value instructional phrases  
- **Context Compression**: Summarize less critical historical information
- **Smart Truncation**: Preserve essential information when content exceeds budgets

### 3. Learning Mechanisms
- **Pattern Recognition**: Identify recurring user preferences and needs
- **Error Analysis**: Learn from tool failures and communication breakdowns
- **Adaptation Triggers**: Specific conditions that trigger instruction updates
- **Feedback Integration**: Incorporate user corrections into future guidance

## Implementation Strategies

### Memory Layer Integration
1. **Layer Ordering**: Strategic placement in memory stack for optimal recall
2. **State Management**: Persistent storage of learned patterns and preferences  
3. **Inheritance Rules**: How child agents receive and modify parent instructions
4. **Budget Allocation**: Optimal token distribution across instruction types

### Content Generation Patterns
1. **Template Systems**: Structured templates for consistent instruction formatting
2. **Dynamic Insertion**: Runtime injection of context-specific guidance
3. **Conditional Sections**: Content that appears only under specific conditions
4. **Multi-Modal Support**: Instructions that work across different interaction modes

### Performance Optimization
1. **Caching Strategies**: Cache static content, recompute only dynamic portions
2. **Lazy Loading**: Generate detailed content only when needed
3. **Compression Techniques**: Efficient representation of instructional content
4. **Profiling Tools**: Measure and optimize instruction effectiveness

## Best Practices

### Instruction Design
- **Clarity Over Brevity**: Instructions should be unambiguous even if longer  
- **Actionable Content**: Every instruction should lead to specific behaviors
- **Contextual Relevance**: Tailor instructions to current capabilities and constraints
- **Consistent Terminology**: Use stable vocabulary across all instruction sources

### System Integration
- **Modular Architecture**: Independent layers that can be mixed and matched
- **Testing Framework**: Validate instruction effectiveness through systematic testing
- **Monitoring Systems**: Track instruction impact on agent performance  
- **Version Control**: Manage instruction evolution over time

### User Experience
- **Transparent Operation**: Users can inspect and understand instruction sources
- **Customization Options**: Allow user preferences to influence instruction generation
- **Feedback Mechanisms**: Channels for users to report instruction effectiveness
- **Progressive Enhancement**: System improves over time based on usage patterns

## Measuring Success

### Quantitative Metrics
- **Token Efficiency**: Instructions per token ratio and budget utilization
- **Response Quality**: Reduced need for clarification and correction
- **Task Completion**: Success rate for complex multi-step operations
- **Error Reduction**: Decreased frequency of tool usage mistakes

### Qualitative Indicators
- **User Satisfaction**: Feedback on agent responsiveness and helpfulness
- **Instruction Clarity**: Reduced confusion about agent capabilities
- **Adaptability**: System responsiveness to changing user needs
- **Consistency**: Reliable behavior patterns across similar tasks

## Common Patterns to Implement

### Code Review Guidance
- Systematic review checklists and security considerations
- Pattern recognition for common issues and improvements
- Integration with development workflow tools

### Debugging Assistance  
- Structured debugging methodologies and tool guidance
- Error pattern analysis and solution recommendations
- Integration with logging and diagnostic tools

### Performance Optimization
- Profiling guidance and bottleneck identification techniques
- Optimization strategies for different system components
- Performance metrics tracking and improvement measurement

This skill provides the foundational knowledge for building sophisticated prompt engineering systems that adapt, learn, and improve over time while maintaining optimal performance and user experience.