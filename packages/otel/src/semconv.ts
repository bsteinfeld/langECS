// Semantic-convention attribute names, inlined.
//
// The GenAI conventions are **Development (incubating)** maturity — they live in
// `@opentelemetry/semantic-conventions/incubating`, an entrypoint whose exports
// churn between releases with no semver guarantee. Per upstream guidance for
// instrumentation libraries, incubating attribute names should be inlined
// rather than imported, so this package deliberately has no dependency on
// `@opentelemetry/semantic-conventions`.
//
// Registry (names current as of semconv >= 1.36):
// - GenAI:  https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
// - error:  https://opentelemetry.io/docs/specs/semconv/registry/attributes/error/

/** The name of the operation being performed, e.g. `'chat'` or `'execute_tool'`. */
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
/** The GenAI provider as identified by the instrumented code, e.g. `'openai'`. */
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
/** The name of the GenAI model a request is being made to. */
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
/** The name of the model that generated the response. */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
/** The number of tokens used in the model input (prompt). */
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
/** The number of tokens used in the model output (completion). */
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
/** Array of reasons the model stopped generating tokens. */
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
/** The name of the tool being executed. */
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
/** Chat history provided to the model as input (opt-in, privacy-sensitive). */
export const ATTR_GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
/** Messages returned by the model (opt-in, privacy-sensitive). */
export const ATTR_GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
/** Stable `error.*` convention: a low-cardinality error class, e.g. the error name. */
export const ATTR_ERROR_TYPE = 'error.type';

// `langecs.*` — this package's own namespace for engine-level attributes.

/** World id (`world.id`) — the persistence key (R12/R37). */
export const ATTR_LANGECS_WORLD_ID = 'langecs.world.id';
/** Run id, identical to the `run:start` event's `runId`. */
export const ATTR_LANGECS_RUN_ID = 'langecs.run.id';
/** Final `RunStatus`: `done | pending | error | idle | limit`. */
export const ATTR_LANGECS_RUN_STATUS = 'langecs.run.status';
/** Number of committed steps in the run. */
export const ATTR_LANGECS_RUN_STEPS = 'langecs.run.steps';
/** The world's committed step counter for this step. */
export const ATTR_LANGECS_STEP_NUMBER = 'langecs.step.number';
/** Number of (system, entity) pairs scheduled in a step. */
export const ATTR_LANGECS_SCHEDULED_COUNT = 'langecs.scheduled.count';
/** System registration key, e.g. `'researcher:callLLM'` for agent-scoped systems. */
export const ATTR_LANGECS_SYSTEM_KEY = 'langecs.system.key';
/** The system definition's own name (key minus the agent scope). */
export const ATTR_LANGECS_SYSTEM_NAME = 'langecs.system.name';
/** Entity id of the executing (system, entity) pair. */
export const ATTR_LANGECS_ENTITY_ID = 'langecs.entity.id';
/** Number of committed component changes in a step. */
export const ATTR_LANGECS_CHANGES_COUNT = 'langecs.changes.count';
/** Number of entities spawned in a step. */
export const ATTR_LANGECS_SPAWNED_COUNT = 'langecs.spawned.count';
/** Number of entities despawned in a step. */
export const ATTR_LANGECS_DESPAWNED_COUNT = 'langecs.despawned.count';
