// @langecs/eval public surface — re-exports components, scorers, systems,
// and dataset loaders (the complete eval source surface).

export {
  CaseTag,
  DatasetTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from './components';
export { defineDataset, type EvalCase, loadDataset } from './dataset';
export {
  type EvalCaseResult,
  type EvalSuiteResult,
  type RunEvalSuiteOptions,
  runEvalSuite,
} from './harness';
export { type JudgeVerdict, type LlmJudgeOptions, llmJudgeScorer } from './judge';
export {
  containsScorer,
  customPredicateScorer,
  exactMatchScorer,
  jsonSchemaScorer,
  numericToleranceScorer,
  regexScorer,
  registerBuiltinScorers,
  SCORER_RESOURCE_PREFIX,
  type Scorer,
  scorerResourceName,
} from './scorers';
export { assertSnapshotMatch, normalizeSnapshot } from './snapshot';
export { registerEvalSystems, scoreCase, verdictSystem } from './systems';
