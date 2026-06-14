/**
 * `defineSubHarness` — the one-call constructor every `@noetic-tools/sub-harness-*`
 * package uses. The adapter supplies a `runner` (an async stream of
 * {@link SubHarnessStreamPart}s for one turn); this builds the full
 * {@link SubHarness} + session lifecycle around it, driving each turn through a
 * {@link SubHarnessTurnAccumulator}.
 */

import type {
  Item,
  SubHarness,
  SubHarnessBuiltinTool,
  SubHarnessKind,
  SubHarnessRunContext,
  SubHarnessSession,
  SubHarnessSettings,
  SubHarnessStartOptions,
  SubHarnessStreamPart,
} from '@noetic-tools/types';
import { SubHarnessTurnAccumulator } from './turn';

/** @public Everything a runner needs to execute one agentic turn. */
export interface SubHarnessTurnInput {
  /** Fresh turn input. */
  prompt: string;
  /** Workspace surface (cwd, fs, shell, subprocess). */
  ctx: SubHarnessRunContext;
  /** Resolved settings (per-step merged over the adapter's defaults). */
  settings: SubHarnessSettings;
  /** System instructions for the first message of a fresh session. */
  instructions?: string;
  /**
   * Prior conversation history seeding a fresh session, so the agent has full
   * context of the conversation so far. Populated only on the first turn of a
   * fresh session; empty thereafter (the session then owns its own history).
   */
  history: ReadonlyArray<Item>;
  signal?: AbortSignal;
}

/**
 * Executes one turn against the underlying agent, yielding normalized stream
 * parts. The default runner typically wraps a vendor SDK or CLI; tests inject a
 * runner that yields canned parts.
 * @public
 */
export type SubHarnessRunner = (input: SubHarnessTurnInput) => AsyncIterable<SubHarnessStreamPart>;

/** @public Options for {@link defineSubHarness}. */
export interface DefineSubHarnessOptions {
  harnessId: SubHarnessKind;
  runner: SubHarnessRunner;
  builtinTools?: SubHarnessBuiltinTool[];
  /** Defaults merged under each step's `settings`. */
  defaultSettings?: SubHarnessSettings;
}

function createRunnerSession(
  def: DefineSubHarnessOptions,
  start: SubHarnessStartOptions,
): SubHarnessSession {
  const sessionId = crypto.randomUUID();
  const settings: SubHarnessSettings = {
    ...def.defaultSettings,
    ...start.settings,
  };
  // History seeds only the first turn of a fresh session; after that the
  // underlying agent owns its own conversation history.
  let firstTurn = true;

  return {
    sessionId,
    isResume: start.resumeFrom !== undefined,
    modelId: settings.model,
    async doPromptTurn(turn) {
      const history = firstTurn ? (start.history ?? []) : [];
      firstTurn = false;
      const accumulator = new SubHarnessTurnAccumulator({
        emit: turn.emit,
      });
      accumulator.push({
        type: 'stream-start',
      });
      const stream = def.runner({
        prompt: turn.prompt,
        ctx: start.ctx,
        settings,
        instructions: start.instructions,
        history,
        signal: turn.signal ?? start.signal,
      });
      for await (const part of stream) {
        accumulator.push(part);
      }
      return accumulator.result();
    },
    async doStop() {
      return {
        harnessId: def.harnessId,
        sessionId,
        state: null,
      };
    },
    async doDestroy() {
      // Stateless runner sessions hold no external resources to release.
    },
  };
}

/** @public Build a {@link SubHarness} from a turn runner. */
export function defineSubHarness(def: DefineSubHarnessOptions): SubHarness {
  return {
    specificationVersion: 'harness-v1',
    harnessId: def.harnessId,
    builtinTools: def.builtinTools,
    async doStart(start) {
      return createRunnerSession(def, start);
    },
  };
}
