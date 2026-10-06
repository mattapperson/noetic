//#region Adapters

/** @public */
export { createInMemoryFsAdapter } from './adapters/in-memory-fs-adapter';
/** @public */
export { createInMemoryShellAdapter } from './adapters/in-memory-shell-adapter';
/** @public */
export { createInMemorySubprocessAdapter } from './adapters/in-memory-subprocess-adapter';

/** @public */
export { createOpenRouterEmbed } from './adapters/openrouter';

//#endregion

//#region Builders

/** @public */
export type { AcpAgentToolOptions } from './builders/acp-agent-tool';
/** @public */
export { acpAgentTool } from './builders/acp-agent-tool';
/** @public */
export { channel } from './builders/channel-builder';
/** @public */
export { context } from './builders/context-builder';
/** @public */
export { conditional, inParallel } from './builders/control-flow-builders';
/** @public */
export type { ScheduleOptions } from './builders/every';
/** @public */
export { schedule } from './builders/every';
/** @public */
export { layerData, layerFunction } from './builders/layer-provides-builders';
/** @public */
export type { LoopConfig } from './builders/loop-builder';
/** @public */
export { loop } from './builders/loop-builder';
/** @public */
export { withContext } from './builders/provide-builder';
/** @public */
export { spawn } from './builders/spawn-builder';
/** @public */
export type { CallModelOpts, InvokeToolOpts, RunCodeOpts } from './builders/step-builders';
/** @public */
export { callModel, invokeTool, runCode, step } from './builders/step-builders';
/** @public */
export { tool, toolWithGenerator } from './builders/tool-builder';
/** @public */
export type { HydrationContext } from './builders/workflow-hydrator';
/** @public */
export { hydrateNode, hydrateWorkflow } from './builders/workflow-hydrator';
/** @public */
export type { WorkflowOpts } from './builders/workflow-step';
/** @public */
export { workflow } from './builders/workflow-step';

//#endregion

//#region Conditions

/** @public */
export type { Condition, OtherwiseClause, WhenClause } from './conditions/conditions';
/** @public */
export {
  aiCondition,
  allCondition,
  anyCondition,
  embeddingMatch,
  otherwise,
  semanticRoute,
  semanticSwitch,
  when,
} from './conditions/conditions';
/** @public */
export { cosineSimilarity } from './conditions/cosine-similarity';

//#endregion

//#region Errors

/** @public */
/** @public */
export {
  isNoeticConfigError,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';

//#endregion

//#region Ask-User Schemas

/** @public */
export type {
  AskUserAnnotation,
  AskUserInput,
  AskUserOption,
  AskUserOutput,
  AskUserQuestion,
} from './types/ask-user-types';
/** @public */
export {
  AskUserAnnotationSchema,
  AskUserInputSchema,
  AskUserOptionSchema,
  AskUserOutputSchema,
  AskUserQuestionSchema,
} from './types/ask-user-types';

//#endregion

//#region Execution

/** @public */
export { execute } from './interpreter/execute';

//#endregion

//#region Context Layers

/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
export type {
  CompactHistoryParams,
  CreateCompactionParams,
  FactExtractor,
  FactSearcher,
  HistoryConfig,
  HistoryPressure,
  ObservationsConfig,
  ObservationsState,
  PlanConfig,
  PlanEnterSessionCallback,
  PlanExecutionEntry,
  PlanExitCallback,
  PlanState,
  ScratchpadConfig,
  ScratchpadState,
  TaskState,
  TemporalConfig,
  TemporalFact,
  TemporalSearchResult,
} from '@noetic-tools/context';
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
/** @public */
export {
  compactHistory,
  compactionAsItem,
  createCompaction,
  filesystem,
  findFunctionCall,
  foldCompactions,
  hasCompaction,
  history,
  historyPressure,
  instructions,
  observations,
  PlanPhase,
  PlanStyle,
  plan,
  scratchpad,
  steering,
  storageGetMany,
  stripUnresolvedToolCalls,
  taskState,
  temporal,
  toolCalls,
} from '@noetic-tools/context';

//#endregion

//#region Message Utilities

/** @public */
export { createMessage, estimateTokens } from '@noetic-tools/types';

//#endregion

//#region Observability

/** @public */
export { GenAI, NoeticAttr, ToolAttr } from './observability/genai-attributes';
/** @public */
export { InMemoryExporter, NoopExporter } from './observability/trace-exporter';
/** @public */
export { createInMemoryStorage } from './runtime/in-memory-storage';

//#endregion

//#region JSON Workflow Runtime

/** @public */
export type { DynamicWorkflowOpts, ParseAndRunWorkflowOpts } from './builders/dynamic-workflow';
/** @public */
export { dynamicWorkflow, parseAndRunWorkflow } from './builders/dynamic-workflow';

//#endregion

//#region Runtime

/** @public */
export type {
  AgentEnvironmentConfig,
  StorageEnvironmentConfig,
} from './harness/agent-harness';
/** @public */
export { AgentHarness } from './harness/agent-harness';
/** @public */
export type {
  AfterFirstTurnContext,
  CheckpointStore,
  CreateCheckpointStoreOptions,
  CreateNudgeMessageOpts,
  DetachedSignal,
  RunnableLoopHarness,
  RunnableLoopOpts,
  SessionSeedHarness,
  StallNudgeOpts,
  StepLedgerRetention,
  StepLedgerStats,
} from './runtime/durable';
/** @public */
export {
  CheckpointKeys,
  createCheckpointStore,
  createDetachedSignal,
  createNudgeMessage,
  createStallNudgeHook,
  DEFAULT_NUDGE_MESSAGE_TEXT,
  DEFAULT_STEP_LEDGER_RETENTION,
  runnableLoop,
  seedFromItems,
} from './runtime/durable';
/** @public */
export { getRegistry, lookupStep, registerStep } from './runtime/step-registry';

//#endregion

//#region Schemas

/** @public */
export { defaultItemSchemaRegistry, ItemSchema, ItemSchemaRegistry } from '@noetic-tools/types';
/** @public */
export type {
  AcpAgentWorkflowNode,
  CallModelWorkflowNode,
  ConditionalRoute,
  ConditionalWorkflowNode,
  InParallelWorkflowNode,
  InvokeToolWorkflowNode,
  LoopWorkflowNode,
  MergeStrategy,
  ScheduleWorkflowNode,
  SequenceWorkflowNode,
  SpawnWorkflowNode,
  SubflowWorkflowNode,
  UntilPredicate,
  WithContextWorkflowNode,
  WorkflowDocument,
  WorkflowNode,
} from './schemas/workflow';
/** @public */
export {
  MergeStrategySchema,
  UntilPredicateSchema,
  validateWorkflow,
  WorkflowDocumentSchema,
  WorkflowNodeSchema,
  walkWorkflow,
  workflowDepth,
} from './schemas/workflow';

//#endregion

//#region Types — Channels

/** @public */
export type { Channel, ChannelHandle, ExternalChannel } from '@noetic-tools/types';

//#endregion

//#region Types — Common

/** @public */
/** @public */
export type {
  InferSchemaInput,
  InferSchemaOutput,
  InputSchemaConfig,
  LLMResponse,
  LlmProviderConfig,
  ModelParams,
  RetryPolicy,
  RoundUsage,
  SchemaValidationFailure,
  SchemaValidationResult,
  SchemaValidationSuccess,
  ServerToolSpec,
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StepMeta,
  TokenUsage,
  Tool,
  ToolContextDeclaration,
} from '@noetic-tools/types';
/** @public */
export {
  isServerToolSpec,
  isStandardJsonSchema,
  isZodSchema,
  standardIssuesToZodError,
  validateSchema,
} from '@noetic-tools/types';

//#endregion

//#region Types — Context

/** @public */
/** @public */
/** @public */
export type {
  Context,
  ContextHarness,
  CwdState,
  EpochUsage,
  ItemLog,
  LastLayerUsage,
  LayerUsageEntry,
  RestoreContextOptions,
} from '@noetic-tools/types';
/** @public */
export { getToolCwd, setToolCwd, snapshotCwdState } from './runtime/cwd-helpers';

//#endregion

//#region Types — Detached

/** @public */
export type { DetachedHandle } from '@noetic-tools/types';
/** @public */
export { DetachedStatus } from '@noetic-tools/types';

//#endregion

//#region Types — Embed

/** @public */
export type { EmbedFn } from './types/embed';

//#endregion

//#region Types — Checkpoint

/** @public */
export type {
  CheckpointSnapshot,
  CwdSnapshot,
  FrontierFrame,
  ItemLogSnapshot,
  PendingAskUserSnapshot,
} from './types/checkpoint';
/** @public */
export {
  CheckpointSchemaVersion,
  CheckpointSnapshotSchema,
  CwdSnapshotSchema,
  FrontierFrameSchema,
  ItemLogSnapshotSchema,
  PendingAskUserSnapshotSchema,
} from './types/checkpoint';

//#endregion

//#region Types — Error

/** @public */
export type { NoeticError } from '@noetic-tools/types';

//#endregion

//#region Types — Items

/** @public */
export type {
  ContentPart,
  DeveloperMessageExtensionItem,
  ExecuteInput,
  ExtendedItem,
  ExtensionItem,
  FileSearchItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ImageGenerationItem,
  InferExtendedItem,
  InputContentPart,
  InputFilePart,
  InputImagePart,
  InputMessageItem,
  InputTextPart,
  Item,
  ItemBase,
  ItemSchemaExtensions,
  MessageItem,
  OutputItem,
  OutputTextPart,
  ReasoningItem,
  ReasoningTextPart,
  RefusalPart,
  ServerToolItem,
  SummaryTextPart,
  WebSearchItem,
} from '@noetic-tools/types';

//#endregion

//#region Types — Context Layers

/** @public */
export type {
  BudgetConfig,
  CompleteParams,
  ContextConfig,
  ContextData,
  ContextLayer,
  ContextLayerHooks,
  DisposeParams,
  InferContext,
  InferContextShape,
  InitParams,
  InitResult,
  LayerDataDecl,
  LayerFunctionDecl,
  LayerPlacement,
  LayerProvides,
  LayerTimeouts,
  ProjectionPolicy,
  RecallParams,
  RecallResult,
  RenderDeltaParams,
  ReturnParams,
  ReturnResult,
  ScopedStorage,
  SpawnParams,
  SpawnResult,
  StorageAdapter,
  StoreParams,
  StoreResult,
} from '@noetic-tools/context';
/** @public */
export { Slot } from '@noetic-tools/context';
/** @public */
export type {
  ContextScope,
  ExecutionContext,
  ExecutionOutcome,
  LayerCallModelRequest,
} from '@noetic-tools/types';

//#endregion

//#region Types — Observability

/** @public */
export type { LayerTraceSpan, Span, TraceExporter } from '@noetic-tools/types';

//#endregion

//#region Types — Harness Result

/** @public */
export type {
  FrameworkStreamEvent,
  HarnessResponse,
  SdkStreamEvent,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';

//#endregion

//#region Types — Runtime

/** @public */
export type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  ContextCacheConfig,
  ContextCacheStore,
  ContextEpoch,
  DeliveryMode,
  ExecuteOptions,
  HarnessStatus,
  ItemSchemaConfig,
  ReanchorReason,
  RecallLayerOutput,
  SessionScope,
  SessionUsage,
} from '@noetic-tools/types';

//#endregion

//#region Types — Steering

/** @public */
export type {
  AfterModelCallParams,
  AfterModelCallResult,
  BeforeToolCallParams,
  BeforeToolCallResult,
  LedgerEntry,
  SteeringConfig,
  SteeringDecision,
  SteeringRule,
  SteeringState,
} from '@noetic-tools/types';
/** @public */
export { LedgerEntryKind, SteeringAction } from '@noetic-tools/types';

//#endregion

//#region Types — Steps

/** @public */
export type {
  ExecuteStepFn,
  SettleResult,
  Snapshot,
  Step,
  StepAcpAgent,
  StepCallModel,
  StepConditional,
  StepInParallel,
  StepInParallelAll,
  StepInParallelRace,
  StepInParallelSettle,
  StepInvokeTool,
  StepLoop,
  StepRunCode,
  StepSpawn,
  StepWithContext,
  Until,
  Verdict,
} from '@noetic-tools/types';

//#endregion

//#region Types — ACP agents

/** @public */
export type {
  AcpAgent,
  AcpAgentCapabilities,
  AcpAgentConnection,
  AcpAuthMethod,
  AcpAvailableCommand,
  AcpBoundPermissionHandler,
  AcpClientCapabilityConfig,
  AcpClientHost,
  AcpConnectOptions,
  AcpContentBlock,
  AcpKeepAlive,
  AcpLiveSession,
  AcpLoadSessionOptions,
  AcpMcpServer,
  AcpNewSessionOptions,
  AcpPermissionHandler,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpPermissionPolicy,
  AcpPermissionRequestInfo,
  AcpPermissionRule,
  AcpPermissionSteerer,
  AcpPlanEntry,
  AcpPromptCapabilities,
  AcpPromptOptions,
  AcpRequestPermissionRequest,
  AcpSession,
  AcpSessionDisposer,
  AcpSessionInfo,
  AcpSessionMode,
  AcpSessionModeState,
  AcpSessionNotification,
  AcpSessionPolicy,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolKind,
  AcpTransport,
  AcpTransportFactory,
  AcpTransportOptions,
  AcpTurnResult,
} from '@noetic-tools/types';
/** @public */
export {
  ACP_AGENT_STEP_KIND,
  AcpCapabilityError,
  AcpConnectError,
  AcpPermissionDecision,
  isAcpCapabilityError,
  isAcpConnectError,
} from '@noetic-tools/types';

//#endregion

//#region Types — Filesystem

/** @public */
export type { FsAdapter, FsStats } from '@noetic-tools/types';

//#endregion

//#region Types — Shell

/** @public */
/** @public */
export type {
  ProcessSubprocessRequest,
  SerializedError,
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  StepSubprocessOverrides,
  StepSubprocessRequest,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
  SubprocessStatus,
  SubprocessStopResult,
} from '@noetic-tools/types';
/** @public */
export { TIMEOUT_ERROR_PREFIX } from '@noetic-tools/types';
/** @public Reusable error-serialiser used by custom SubprocessAdapter implementations. */
export { serializeError } from './adapters/in-memory-subprocess/metadata';

//#endregion

//#region Types — Tool Context

/** @public */
export type { ToolContext, ToolExecutionContext } from '@noetic-tools/types';

//#endregion

//#region Until

/** @public */
export { all, any } from './until/combinators';
/** @public */
export type { ConvergeConfig, VerifyFn } from './until/predicates';
/** @public */
export { until } from './until/predicates';

//#endregion
