// GenAI-semconv instrumentation for a core `Model` (SPEC §13: `@langecs/otel`).
//
// One CLIENT span per `generate`/`stream` call, named `chat {model}` per the
// GenAI conventions' `{gen_ai.operation.name} {gen_ai.request.model}` rule.
// The conventions are Development/incubating (see src/semconv.ts); message
// content capture is opt-in for privacy — via the option or the standard
// `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` env var.

import type { Model, ModelRequest, ModelResult } from '@langecs/core';
import type { Attributes, TracerProvider } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from './semconv';
import {
  envFlag,
  errorMessage,
  errorName,
  isInstrumented,
  markInstrumented,
  safeStringify,
  toException,
  tracerFrom,
} from './shared';

/** Max chars for captured `gen_ai.input.messages` / `gen_ai.output.messages`. */
const MESSAGE_CAPTURE_LIMIT = 16384;

export interface InstrumentModelOptions {
  /** `gen_ai.provider.name`, e.g. `'openai'`. Omitted from the span when absent. */
  provider?: string;
  /** `gen_ai.request.model` and the `chat {model}` span name (else `'unknown'`). */
  model?: string;
  /** Defaults to the API-global tracer provider. */
  tracerProvider?: TracerProvider;
  /**
   * Capture full message content as `gen_ai.input.messages` /
   * `gen_ai.output.messages` (privacy-sensitive, semconv Development).
   * Default: `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true'`.
   */
  captureMessageContent?: boolean;
}

/**
 * Wraps a `Model` so every `generate` (and `stream`, when the model has one)
 * call produces a GenAI `chat` span. The wrapper preserves the model's other
 * properties and never *adds* a `stream` method the original lacked.
 * Idempotent: an already-instrumented model is returned as-is, so combining
 * explicit wrapping with `instrumentWorld`'s `wrapResources` auto-wrap never
 * produces nested duplicate `chat` spans.
 */
export function instrumentModel(model: Model, options: InstrumentModelOptions = {}): Model {
  if (isInstrumented(model)) return model;
  const tracer = tracerFrom(options.tracerProvider);
  const capture =
    options.captureMessageContent ?? envFlag('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT');
  const spanName = `chat ${options.model ?? 'unknown'}`;

  const withSpan = (req: ModelRequest, call: () => Promise<ModelResult>): Promise<ModelResult> => {
    const attributes: Attributes = { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' };
    if (options.provider !== undefined) attributes[ATTR_GEN_AI_PROVIDER_NAME] = options.provider;
    if (options.model !== undefined) attributes[ATTR_GEN_AI_REQUEST_MODEL] = options.model;
    if (capture) {
      attributes[ATTR_GEN_AI_INPUT_MESSAGES] = safeStringify(req.messages, MESSAGE_CAPTURE_LIMIT);
    }
    return tracer.startActiveSpan(spanName, { kind: SpanKind.CLIENT, attributes }, async (span) => {
      try {
        const result = await call();
        const usage = result.usage;
        if (usage?.inputTokens !== undefined) {
          span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
        }
        if (usage?.outputTokens !== undefined) {
          span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
        }
        if (result.finishReason !== undefined) {
          span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [result.finishReason]);
        }
        if (capture) {
          span.setAttribute(
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            safeStringify([result.message], MESSAGE_CAPTURE_LIMIT),
          );
        }
        span.end();
        return result;
      } catch (err) {
        span.recordException(toException(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
        span.setAttribute(ATTR_ERROR_TYPE, errorName(err));
        span.end();
        throw err;
      }
    });
  };

  // Spread first so extra properties survive; then wrap the methods through
  // the original object, which also picks up prototype-defined methods.
  const wrapped: Model = {
    ...model,
    generate: (req) => withSpan(req, () => model.generate(req)),
  };
  const stream = model.stream;
  if (typeof stream === 'function') {
    wrapped.stream = (req, onChunk) => withSpan(req, () => stream.call(model, req, onChunk));
  }
  return markInstrumented(wrapped);
}
