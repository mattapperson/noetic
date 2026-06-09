/**
 * Communication style memory layer — adaptive communication patterns.
 *
 * Manages sophisticated communication styles based on Claude Code patterns.
 * Adapts based on user interactions, task complexity, and conversation context.
 */

import type { Item, MemoryLayer } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';

//#region Types

interface CommunicationStyleState {
  style: 'concise' | 'normal' | 'verbose';
  userPreferences: {
    prefersExplanations: boolean;
    prefersDirectAnswers: boolean;
    asksTechnicalQuestions: boolean;
  };
  conversationMetrics: {
    totalUserMessages: number;
    averageUserMessageLength: number;
    recentUserQuestions: number;
  };
  lastStyleUpdate: number;
}

//#endregion

//#region Item Extraction

/**
 * Extract the concatenated text of a user message item, or `null` if the item
 * is not a user message. Reads the Open Responses `InputTextPart[]` content.
 */
function extractUserMessageText(item: Item): string | null {
  if (item.type !== 'message' || item.role !== 'user') {
    return null;
  }
  return item.content
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text)
    .join('');
}

//#endregion

//#region Helpers

function createInitialState(): CommunicationStyleState {
  return {
    style: 'normal',
    userPreferences: {
      prefersExplanations: false,
      prefersDirectAnswers: false,
      asksTechnicalQuestions: false,
    },
    conversationMetrics: {
      totalUserMessages: 0,
      averageUserMessageLength: 0,
      recentUserQuestions: 0,
    },
    lastStyleUpdate: Date.now(),
  };
}

function analyzeUserMessage(content: string): {
  length: number;
  isQuestion: boolean;
  isTechnical: boolean;
  prefersExplanation: boolean;
  prefersDirectAnswer: boolean;
} {
  const length = content.length;
  const isQuestion =
    content.includes('?') ||
    Boolean(
      content
        .toLowerCase()
        .match(/^(what|how|why|when|where|which|can you|could you|would you|do you)/),
    );

  // Technical indicators
  const technicalKeywords = [
    'function',
    'class',
    'method',
    'api',
    'database',
    'algorithm',
    'implementation',
    'architecture',
    'pattern',
    'framework',
    'library',
    'code',
    'debug',
    'error',
    'exception',
    'syntax',
    'typescript',
    'javascript',
  ];
  const isTechnical = technicalKeywords.some((keyword) => content.toLowerCase().includes(keyword));

  // Explanation preference indicators
  const explanationKeywords = [
    'explain',
    'why',
    'how does',
    'what is',
    'help me understand',
    'walk me through',
    'break down',
    'elaborate',
    'detail',
  ];
  const prefersExplanation = explanationKeywords.some((keyword) =>
    content.toLowerCase().includes(keyword),
  );

  // Direct answer preference indicators
  const directAnswerKeywords = [
    'just',
    'simply',
    'quick',
    'brief',
    'short',
    'directly',
    'yes or no',
    'straight answer',
    'bottom line',
  ];
  const prefersDirectAnswer = directAnswerKeywords.some((keyword) =>
    content.toLowerCase().includes(keyword),
  );

  return {
    length,
    isQuestion,
    isTechnical,
    prefersExplanation,
    prefersDirectAnswer,
  };
}

function adaptStyleBasedOnAnalysis(
  currentState: CommunicationStyleState,
  recentAnalyses: Array<ReturnType<typeof analyzeUserMessage>>,
): 'concise' | 'normal' | 'verbose' {
  if (recentAnalyses.length === 0) {
    return currentState.style;
  }

  const directAnswerRequests = recentAnalyses.filter((a) => a.prefersDirectAnswer).length;
  const explanationRequests = recentAnalyses.filter((a) => a.prefersExplanation).length;
  const technicalQuestions = recentAnalyses.filter((a) => a.isTechnical).length;
  const averageLength =
    recentAnalyses.reduce((sum, a) => sum + a.length, 0) / recentAnalyses.length;

  // Adapt based on patterns
  if (directAnswerRequests > explanationRequests && averageLength < 50) {
    return 'concise';
  }
  if (
    explanationRequests > directAnswerRequests ||
    technicalQuestions > recentAnalyses.length / 2
  ) {
    return 'verbose';
  }
  return 'normal';
}

function getCommunicationGuidelines(
  style: 'concise' | 'normal' | 'verbose',
  preferences: CommunicationStyleState['userPreferences'],
): string {
  const baseGuidelines = `# Communication Style: ${style.charAt(0).toUpperCase() + style.slice(1)}

## Core Formatting Rules
- Use file_path:line_number format for code references
- Use owner/repo#123 format for GitHub references
- Don't use colons before tool calls
- Lead with answers, not process descriptions`;

  const styleSpecificGuidelines = {
    concise: `
## Concise Mode Guidelines
- Lead with the answer, skip reasoning unless asked
- One sentence instead of three when possible
- No filler words or unnecessary transitions
- Focus only on actionable information
- Skip explanations unless specifically requested`,

    normal: `
## Normal Mode Guidelines
- Provide clear answers with brief context
- Include reasoning when it helps understanding
- Use structured formatting for complex information
- Balance efficiency with clarity`,

    verbose: `
## Verbose Mode Guidelines
- Provide detailed explanations and context
- Include reasoning and background information
- Use structured formatting extensively
- Anticipate follow-up questions with thorough answers`,
  };

  const preferenceGuidelines = [];
  if (preferences.prefersExplanations) {
    preferenceGuidelines.push('- User appreciates detailed explanations');
  }
  if (preferences.prefersDirectAnswers) {
    preferenceGuidelines.push('- User prefers direct, actionable answers');
  }
  if (preferences.asksTechnicalQuestions) {
    preferenceGuidelines.push('- User asks technical questions - provide appropriate depth');
  }

  return [
    baseGuidelines,
    styleSpecificGuidelines[style],
    preferenceGuidelines.length > 0
      ? `\n## User Preferences\n${preferenceGuidelines.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function updateUserPreferences(
  current: CommunicationStyleState['userPreferences'],
  analyses: Array<ReturnType<typeof analyzeUserMessage>>,
): CommunicationStyleState['userPreferences'] {
  if (analyses.length === 0) {
    return current;
  }

  const explanationCount = analyses.filter((a) => a.prefersExplanation).length;
  const directAnswerCount = analyses.filter((a) => a.prefersDirectAnswer).length;
  const technicalCount = analyses.filter((a) => a.isTechnical).length;

  return {
    prefersExplanations: explanationCount > analyses.length * 0.3,
    prefersDirectAnswers: directAnswerCount > analyses.length * 0.3,
    asksTechnicalQuestions: technicalCount > analyses.length * 0.4,
  };
}

function updateConversationMetrics(
  current: CommunicationStyleState['conversationMetrics'],
  newUserMessages: string[],
): CommunicationStyleState['conversationMetrics'] {
  if (newUserMessages.length === 0) {
    return current;
  }

  const newTotal = current.totalUserMessages + newUserMessages.length;
  const totalLength =
    current.averageUserMessageLength * current.totalUserMessages +
    newUserMessages.reduce((sum, msg) => sum + msg.length, 0);
  const newAverage = totalLength / newTotal;

  const questionCount = newUserMessages.filter(
    (msg) => msg.includes('?') || msg.toLowerCase().match(/^(what|how|why|when|where|which)/),
  ).length;

  return {
    totalUserMessages: newTotal,
    averageUserMessageLength: newAverage,
    recentUserQuestions: current.recentUserQuestions + questionCount,
  };
}

//#endregion

//#region Public API

export function communicationStyleLayer(): MemoryLayer<CommunicationStyleState> {
  return {
    id: 'communication-style',
    name: 'Communication Style',
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 150,
      max: 500,
    },

    hooks: {
      async init() {
        return {
          state: createInitialState(),
        };
      },

      async recall({ state }) {
        return getCommunicationGuidelines(state.style, state.userPreferences);
      },

      async store({ newItems, state }) {
        // Extract user message text from new items
        const userMessages = newItems
          .map(extractUserMessageText)
          .filter((text): text is string => text !== null);

        if (userMessages.length === 0) {
          return {
            state,
          };
        }

        // Analyze each user message
        const analyses = userMessages.map(analyzeUserMessage);

        // Update user preferences based on recent messages
        const updatedPreferences = updateUserPreferences(state.userPreferences, analyses);

        // Update conversation metrics
        const updatedMetrics = updateConversationMetrics(state.conversationMetrics, userMessages);

        // Adapt communication style based on recent patterns
        const adaptedStyle = adaptStyleBasedOnAnalysis(state, analyses);

        return {
          state: {
            ...state,
            style: adaptedStyle,
            userPreferences: updatedPreferences,
            conversationMetrics: updatedMetrics,
            lastStyleUpdate: Date.now(),
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit communication style but start with fresh metrics
        return {
          childState: {
            ...parentState,
            conversationMetrics: createInitialState().conversationMetrics,
            lastStyleUpdate: Date.now(),
          },
        };
      },
    },
  };
}

//#endregion
