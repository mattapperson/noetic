import { answerRelevancy } from './builtin/answer-relevancy';
import { answerSimilarity } from './builtin/answer-similarity';
import { bias } from './builtin/bias';
import { completeness } from './builtin/completeness';
import { contextPrecision } from './builtin/context-precision';
import { contextRelevance } from './builtin/context-relevance';
import { cost } from './builtin/cost';
import { custom } from './builtin/custom';
import { directoryReview } from './builtin/directory-review';
import { faithfulness } from './builtin/faithfulness';
import { fileExists } from './builtin/file-exists';
import { fileReview } from './builtin/file-review';
import { hallucination } from './builtin/hallucination';
import { latency } from './builtin/latency';
import { promptAlignment } from './builtin/prompt-alignment';
import { tokenEfficiency } from './builtin/token-efficiency';
import { toneConsistency } from './builtin/tone-consistency';
import { toolCallAccuracy } from './builtin/tool-call-accuracy';
import { toxicity } from './builtin/toxicity';

export const scorer = {
  // Deterministic
  latency,
  cost,
  tokenEfficiency,
  toolCallAccuracy,
  fileExists,
  custom,
  // LLM-judge
  answerRelevancy,
  answerSimilarity,
  faithfulness,
  hallucination,
  completeness,
  promptAlignment,
  toneConsistency,
  toxicity,
  bias,
  contextPrecision,
  contextRelevance,
  fileReview,
  directoryReview,
} as const;
