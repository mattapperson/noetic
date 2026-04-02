// Runtime module exports for @noetic/ui
import './register';

export { createDebugHarness, DebugAgentHarness } from './debug-harness';
export { Debugger as NoeticDebugger } from './debugger';
export { NoeticUITraceExporter } from './exporter';
export { globalHookManager } from './hook';

// Step data extractor plugin system
export {
  clearStepDataExtractors,
  getRegisteredStepKinds,
  getStepDataExtractor,
  hasStepDataExtractor,
  registerStepDataExtractor,
  type StepDataExtractor,
  unregisterStepDataExtractor,
} from './step-extractors';

export type {
  Breakpoint,
  DebugController,
  DebuggerConfig,
  ExporterOptions,
} from './types';
