// GenAI-semconv instrumentation for tool objects (`execute_tool {name}`).
// Matches the @langecs/stdlib `ToolDef` shape but accepts anything with a
// `name` and an `execute` — every other property is preserved by spread.

import type { TracerProvider } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ATTR_GEN_AI_OPERATION_NAME, ATTR_GEN_AI_TOOL_NAME } from './semconv';
import {
  errorMessage,
  errorName,
  isInstrumented,
  markInstrumented,
  toException,
  tracerFrom,
} from './shared';

export interface InstrumentToolOptions {
  /** Defaults to the API-global tracer provider. */
  tracerProvider?: TracerProvider;
}

/**
 * Wraps a tool's `execute` in a GenAI `execute_tool {name}` span (INTERNAL).
 * Async results are awaited inside the span; errors are recorded
 * (`recordException` + ERROR status + `error.type`) and rethrown. Note the
 * wrapped `execute` always returns a `Promise`, even for sync tools.
 * Idempotent: an already-instrumented tool is returned as-is (see
 * `instrumentModel` for why).
 */
export function instrumentTool<T extends { name: string; execute: (...args: never[]) => unknown }>(
  tool: T,
  options: InstrumentToolOptions = {},
): T {
  if (isInstrumented(tool)) return tool;
  const tracer = tracerFrom(options.tracerProvider);
  const execute = (...args: Parameters<T['execute']>): Promise<unknown> =>
    tracer.startActiveSpan(
      `execute_tool ${tool.name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool',
          [ATTR_GEN_AI_TOOL_NAME]: tool.name,
        },
      },
      async (span) => {
        try {
          const result: unknown = await Reflect.apply(tool.execute, tool, args);
          span.end();
          return result;
        } catch (err) {
          span.recordException(toException(err));
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
          span.setAttribute(ATTR_ERROR_TYPE, errorName(err));
          span.end();
          throw err;
        }
      },
    );
  return markInstrumented({ ...tool, execute } as T);
}
