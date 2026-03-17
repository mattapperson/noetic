/**
 * Re-exports scripted LLM helpers for runnable example files.
 * The canonical implementations live in test/_helpers.ts; this file
 * makes them available to examples/ without pulling in the full test module.
 */
export {
  createScriptedCallModel,
  textOnlyResponse,
  toolCallResponse,
} from '../test/_helpers';
