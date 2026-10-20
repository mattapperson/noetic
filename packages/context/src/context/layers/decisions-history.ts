import type {
  ContextScope,
  DecideAnswer,
  DecisionRecord,
  InitParams,
  InitResult,
  LayerDataDecl,
  OnDecisionParams,
  RecallParams,
  ReturnParams,
  ReturnResult,
  SpawnParams,
  SpawnResult,
} from '@noetic-tools/types';
import { frameworkCast, Slot } from '@noetic-tools/types';
import { layerData } from '../layer-provides';

//#region Types

/** @public Configuration for {@link decisionsHistoryLayer}. */
export interface DecisionsHistoryConfig<Id extends string = 'decisionsHistory'> {
  /** Layer id, and so the `ctx.context` key. Default `'decisionsHistory'`. */
  id?: Id;
  /** Default `'execution'`. With `'thread'` or `'resource'`, history persists across runs. */
  scope?: ContextScope;
  /** Records kept; the oldest drop first. Default 50. */
  maxRecords?: number;
  /** Render a summary of the latest decisions into the view. Default true. */
  recall?: boolean;
  /** Default `Slot.WORKING_MEMORY + 10`. */
  slot?: number;
}

/** @public State held by {@link decisionsHistoryLayer}: records, oldest first. */
export interface DecisionsHistoryState {
  records: DecisionRecord[];
}

/** @public The layer {@link decisionsHistoryLayer} returns, with its literal id kept for `ctx.context` typing. */
export interface DecisionsHistoryLayer<Id extends string> {
  readonly id: Id;
  name: string;
  slot: number;
  scope: ContextScope;
  provides: {
    latest: LayerDataDecl<Readonly<Record<string, DecisionRecord>>, DecisionsHistoryState>;
    all: LayerDataDecl<ReadonlyArray<DecisionRecord>, DecisionsHistoryState>;
  };
  hooks: {
    init(params: InitParams): Promise<InitResult<DecisionsHistoryState>>;
    recall(params: RecallParams<DecisionsHistoryState>): Promise<string | null>;
    onDecision(params: OnDecisionParams<DecisionsHistoryState>): Promise<{
      state: DecisionsHistoryState;
    }>;
    onSpawn(
      params: SpawnParams<DecisionsHistoryState>,
    ): Promise<SpawnResult<DecisionsHistoryState>>;
    onReturn(
      params: ReturnParams<DecisionsHistoryState>,
    ): Promise<ReturnResult<DecisionsHistoryState>>;
  };
}

//#endregion

//#region Public API

const DEFAULT_MAX_RECORDS = 50;

/**
 * A context layer that records every `decide` step's answers. Later steps read
 * them through `ctx.context.decisionsHistory.latest[stepId]`, and later `callModel`
 * steps see a one-line-per-decision summary in their view. inParallel paths and spawn
 * children start with the parent's records and hand their new ones back.
 *
 * @public
 */
export function decisionsHistoryLayer(
  config?: Omit<DecisionsHistoryConfig, 'id'>,
): DecisionsHistoryLayer<'decisionsHistory'>;
export function decisionsHistoryLayer<const Id extends string>(
  config: DecisionsHistoryConfig<Id> & {
    id: Id;
  },
): DecisionsHistoryLayer<Id>;
export function decisionsHistoryLayer(
  config?: DecisionsHistoryConfig<string>,
): DecisionsHistoryLayer<string> {
  const maxRecords = config?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const renders = config?.recall ?? true;
  const keep = (records: DecisionRecord[]): DecisionsHistoryState => ({
    records: records.slice(-maxRecords),
  });

  return {
    id: config?.id ?? 'decisionsHistory',
    name: 'Decisions History',
    slot: config?.slot ?? Slot.WORKING_MEMORY + 10,
    scope: config?.scope ?? 'execution',
    provides: {
      latest: layerData({
        read: (state: DecisionsHistoryState) => latestByStep(state.records),
      }),
      all: layerData({
        read: (state: DecisionsHistoryState): ReadonlyArray<DecisionRecord> => state.records,
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<DecisionsHistoryState>('state');
        return {
          state: saved ?? {
            records: [],
          },
        };
      },
      async recall({ state }) {
        if (!renders || state.records.length === 0) {
          return null;
        }
        return renderSummary(latestByStep(state.records));
      },
      async onDecision({ state, record }) {
        return {
          state: keep([
            ...state.records,
            record,
          ]),
        };
      },
      async onSpawn({ parentState }) {
        return {
          childState: {
            records: [
              ...parentState.records,
            ],
          },
        };
      },
      // Concurrent fork paths each return; merging only the records the parent
      // lacks keeps every sibling's decisions.
      async onReturn({ parentState, childState }) {
        const known = new Set(parentState.records.map(recordKey));
        const added = childState.records.filter((r) => !known.has(recordKey(r)));
        return {
          parentState: keep([
            ...parentState.records,
            ...added,
          ]),
        };
      },
    },
  };
}

//#endregion

//#region Helpers

function recordKey(record: DecisionRecord): string {
  return `${record.stepId}\u0000${record.at}\u0000${record.modelId}`;
}

function latestByStep(records: ReadonlyArray<DecisionRecord>): Record<string, DecisionRecord> {
  const latest: Record<string, DecisionRecord> = {};
  for (const record of records) {
    latest[record.stepId] = record;
  }
  return latest;
}

function renderSummary(latest: Record<string, DecisionRecord>): string {
  const lines = Object.values(latest).map((record) => {
    const answers = Object.entries(record.answers)
      .map(([id, answer]) => `${id}=${renderAnswer(answer)}`)
      .join(', ');
    return `- ${record.stepId}: ${answers}`;
  });
  return [
    'Decisions so far:',
    ...lines,
  ].join('\n');
}

function renderAnswer(answer: DecideAnswer): string {
  switch (answer.type) {
    case 'boolean':
      return `${answer.value ? 'yes' : 'no'} (${round(answer.probability)})`;
    case 'choice':
      return `${answer.value} (${round(frameworkCast<Record<string, number>>(answer.probabilities)[answer.value] ?? 0)})`;
    case 'score':
      return `${answer.level} (${round(answer.value)})`;
    case 'refusal':
      return 'refused';
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

//#endregion
