/**
 * @noetic-tools/sub-harness — the base contract and helpers shared by every
 * `@noetic-tools/sub-harness-*` coding-agent adapter. Re-exports the SubHarness
 * contract from `@noetic-tools/types` (the one-stop import for adapter authors)
 * and adds the registry, turn accumulator, item builders, common-tool
 * vocabulary, and shared error types.
 */

// Contract surface (defined in the dependency-free foundation).
export type {
  SubHarness,
  SubHarnessBuiltinTool,
  SubHarnessContinueState,
  SubHarnessContinueTurnOptions,
  SubHarnessFinishReason,
  SubHarnessPromptTurnOptions,
  SubHarnessResumeState,
  SubHarnessRunContext,
  SubHarnessSession,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
  SubHarnessStartOptions,
  SubHarnessStreamPart,
  SubHarnessTurnResult,
} from '@noetic-tools/types';
export {
  frameworkCast,
  SUB_HARNESS_KINDS,
  SubHarnessKind,
  SubHarnessStreamPartSchema,
} from '@noetic-tools/types';
// Helpers added by this package.
export { commonTool } from './common-tools';
export type {
  DefineSubHarnessOptions,
  SubHarnessRunner,
  SubHarnessTurnInput,
} from './define';
export { defineSubHarness } from './define';
export {
  isSubHarnessCapabilityError,
  isSubHarnessStartError,
  SubHarnessCapabilityError,
  SubHarnessStartError,
} from './errors';
export { formatConversation, withHistoryPrompt } from './history';
export { asItems, assistantMessageItem, functionCallItem } from './items';
export type { SubHarnessRegistry } from './registry';
export { createSubHarnessRegistry } from './registry';
export type { SubHarnessTurnAccumulatorOptions } from './turn';
export { SubHarnessTurnAccumulator } from './turn';
