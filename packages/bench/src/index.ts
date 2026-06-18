// @langecs/bench public surface — re-exports the metric components and the
// pure-function cost layer. Wave 2/3 extend this with metering, aggregation,
// budget assertions, and the optional OTel bridge.

export { assertBudget, type Budget, type BudgetActuals } from './budget';
export {
  type AgentUnderTest,
  type Candidate,
  ComparisonReport,
  type ComparisonReportData,
  type RunComparisonOptions,
  rankCandidates,
  runComparison,
  writeComparisonReport,
} from './compare';
export {
  BenchmarkReport,
  type BenchmarkReportData,
  CostEstimate,
  LatencyMs,
  type Spend,
  StepCount,
  TokenUsage,
} from './components';
export { estimateCost, MODEL_PRICING, type PriceRow, type Usage } from './cost';
export { type MeteredModelOptions, meteredModel } from './metered';
export { type ForwardBenchToOtelOptions, forwardBenchToOtel } from './otel';
export {
  buildBenchmarkReport,
  type RunBenchmarkSuiteOptions,
  runBenchmarkSuite,
  writeBenchmarkReport,
} from './report';
