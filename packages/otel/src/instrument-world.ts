// World instrumentation over `world.observe` (SPEC §14, R45–R48).
//
// Span model:
//   langecs.run                      one per run; parent = whatever span is
//     └─ langecs.step               active when `world.run()` is called
//          └─ langecs.system <key>  one per executing (system, entity) pair
//
// The run span's parent is captured from `context.active()` inside the
// `run:start` tap — the tap fires synchronously inside `world.run()` (R45), so
// a caller's active span (an HTTP request span, say) becomes the run's parent
// without any context plumbing.
//
// System spans are made *active* around the pair's `run` via `wrapSystemRun`
// (R46), so spans created by user code inside a system — model calls, fetches,
// `instrumentModel`/`instrumentTool` spans — nest under the system span.
// Note: that nesting requires the host to have registered a context manager
// (NodeSDK and NodeTracerProvider.register() do; so does manually calling
// `context.setGlobalContextManager(new AsyncLocalStorageContextManager())`).
// Without one, system spans still form a correct run/step/system tree, but
// user-code spans won't parent under them.

import type {
  ChangeRecord,
  Model,
  ObserverEvent,
  ResourceRef,
  RunInfo,
  SystemRunInfo,
  World,
} from '@langecs/core';
import type {
  Attributes,
  Context,
  MeterProvider,
  ObservableResult,
  Span,
  TracerProvider,
} from '@opentelemetry/api';
import {
  context as contextApi,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace as traceApi,
} from '@opentelemetry/api';
import { instrumentModel } from './instrument-model';
import { instrumentTool } from './instrument-tool';
import {
  ATTR_ERROR_TYPE,
  ATTR_LANGECS_CHANGES_COUNT,
  ATTR_LANGECS_DESPAWNED_COUNT,
  ATTR_LANGECS_ENTITY_ID,
  ATTR_LANGECS_RUN_ID,
  ATTR_LANGECS_RUN_STATUS,
  ATTR_LANGECS_RUN_STEPS,
  ATTR_LANGECS_SCHEDULED_COUNT,
  ATTR_LANGECS_SPAWNED_COUNT,
  ATTR_LANGECS_STEP_NUMBER,
  ATTR_LANGECS_SYSTEM_KEY,
  ATTR_LANGECS_SYSTEM_NAME,
  ATTR_LANGECS_WORLD_ID,
} from './semconv';
import {
  errorMessage,
  errorName,
  now,
  SCOPE_NAME,
  SCOPE_VERSION,
  safeStringify,
  toException,
  tracerFrom,
} from './shared';

export interface InstrumentWorldOptions {
  /** Defaults to the API-global tracer provider (`trace.getTracerProvider()`). */
  tracerProvider?: TracerProvider;
  /** Defaults to the API-global meter provider (`metrics.getMeterProvider()`). */
  meterProvider?: MeterProvider;
  /**
   * Add a `langecs.change` span event per committed change on each step span
   * (entity, component, kind, JSON value capped at 2048 chars). Default
   * `false` — change values can carry conversation content.
   */
  captureChanges?: boolean;
  /**
   * Patch `world.register` so models (any value with a `generate` function)
   * and tools (`tool:*` resources with an `execute` function) registered
   * after instrumentation are wrapped with `instrumentModel`/`instrumentTool`
   * automatically. Default `true`; restored on detach.
   */
  wrapResources?: boolean;
}

interface OpenSystemSpan {
  span: Span;
  ended: boolean;
}

interface RunState {
  runSpan: Span;
  runContext: Context;
  startedAt: number;
  stepSpan?: Span;
  stepContext?: Context;
  stepStartedAt?: number;
  /** Spans opened by `wrapSystemRun`, keyed `<systemKey>::<entityId>`. */
  systems: Map<string, OpenSystemSpan>;
}

const pairKey = (system: string, entity: number): string => `${system}::${entity}`;

const changeAttributes = (change: ChangeRecord): Attributes => {
  const attrs: Attributes = {
    entity: change.entity,
    component: change.component,
    kind: change.kind,
  };
  if (change.value !== undefined) attrs.value = safeStringify(change.value, 2048);
  return attrs;
};

/**
 * Attaches OpenTelemetry tracing + metrics to a world. Returns a detach
 * function (idempotent): it unhooks the observer, restores `world.register`,
 * unregisters the entity gauge callback, and defensively ends any spans still
 * open.
 *
 * Emitted metrics: `langecs.run.duration`, `langecs.step.duration`,
 * `langecs.system.duration` (histograms, seconds), `langecs.system.errors`
 * (counter), `langecs.entities` (observable gauge over `world.query()`).
 */
export function instrumentWorld(world: World, options: InstrumentWorldOptions = {}): () => void {
  const tracer = tracerFrom(options.tracerProvider);
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(
    SCOPE_NAME,
    SCOPE_VERSION,
  );
  const captureChanges = options.captureChanges ?? false;
  const wrapResources = options.wrapResources ?? true;

  const runDuration = meter.createHistogram('langecs.run.duration', {
    unit: 's',
    description: 'Duration of one world run (run:start to run:end/run:reject).',
  });
  const stepDuration = meter.createHistogram('langecs.step.duration', {
    unit: 's',
    description: 'Duration of one committed step (step:start to step:applied).',
  });
  const systemDuration = meter.createHistogram('langecs.system.duration', {
    unit: 's',
    description: 'Duration of one (system, entity) pair execution.',
  });
  const systemErrors = meter.createCounter('langecs.system.errors', {
    description: 'System executions that threw (guard throws included).',
  });
  const entityGauge = meter.createObservableGauge('langecs.entities', {
    description: 'Live entity count of the instrumented world.',
  });
  const observeEntities = (result: ObservableResult): void => {
    try {
      result.observe(world.query().length, { [ATTR_LANGECS_WORLD_ID]: world.id });
    } catch {
      // A gauge read must never disturb the host app or the world.
    }
  };
  entityGauge.addCallback(observeEntities);

  const runs = new Map<string, RunState>();

  // key -> definition name, rebuilt lazily so systems registered after
  // instrumentation (world.use) are still resolved.
  let systemNames = new Map<string, string>();
  const systemName = (key: string): string => {
    let name = systemNames.get(key);
    if (name === undefined) {
      systemNames = new Map(world.systems().map((s) => [s.key, s.name]));
      name = systemNames.get(key) ?? key;
    }
    return name;
  };

  const systemAttributes = (system: string, entity: number, step: number): Attributes => ({
    [ATTR_LANGECS_SYSTEM_KEY]: system,
    [ATTR_LANGECS_SYSTEM_NAME]: systemName(system),
    [ATTR_LANGECS_ENTITY_ID]: entity,
    [ATTR_LANGECS_STEP_NUMBER]: step,
  });

  /** Defensively ends whatever is still open below the run span. */
  const endLeftovers = (state: RunState): void => {
    for (const open of state.systems.values()) {
      if (!open.ended) {
        open.ended = true;
        open.span.end();
      }
    }
    state.systems.clear();
    state.stepSpan?.end();
    state.stepSpan = undefined;
    state.stepContext = undefined;
    state.stepStartedAt = undefined;
  };

  const onEvent = (event: ObserverEvent, info: RunInfo): void => {
    switch (event.type) {
      case 'run:start': {
        // The tap is synchronous inside world.run(): context.active() here is
        // the *caller's* context, so its active span parents the run span.
        const active = contextApi.active();
        const runSpan = tracer.startSpan(
          'langecs.run',
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_LANGECS_WORLD_ID]: info.worldId,
              [ATTR_LANGECS_RUN_ID]: event.runId,
            },
          },
          active,
        );
        runs.set(event.runId, {
          runSpan,
          runContext: traceApi.setSpan(active, runSpan),
          startedAt: now(),
          systems: new Map(),
        });
        break;
      }
      case 'step:start': {
        const state = runs.get(info.runId);
        if (!state) break;
        state.stepSpan?.end(); // defensive: a step:start with the prior step still open
        const span = tracer.startSpan(
          'langecs.step',
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_LANGECS_STEP_NUMBER]: event.step,
              [ATTR_LANGECS_SCHEDULED_COUNT]: event.scheduled.length,
            },
          },
          state.runContext,
        );
        state.stepSpan = span;
        state.stepContext = traceApi.setSpan(state.runContext, span);
        state.stepStartedAt = now();
        break;
      }
      case 'system:end': {
        // The wrapper opened and already ended this span — drop the bookkeeping.
        runs.get(info.runId)?.systems.delete(pairKey(event.system, event.entity));
        break;
      }
      case 'system:error': {
        const state = runs.get(info.runId);
        if (!state) break;
        // A span the wrapper opened was already ended (with ERROR) — ignore.
        if (state.systems.delete(pairKey(event.system, event.entity))) break;
        // No wrapSystemRun call happened: a `when` guard threw (R46 — guards
        // are never wrapped). Synthesize the span under the step span.
        const span = tracer.startSpan(
          `langecs.system ${event.system}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: systemAttributes(event.system, event.entity, event.step),
          },
          state.stepContext ?? state.runContext,
        );
        span.recordException(event.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error.message });
        span.setAttribute(ATTR_ERROR_TYPE, event.error.name);
        span.end();
        systemErrors.add(1, { [ATTR_LANGECS_SYSTEM_KEY]: event.system });
        break;
      }
      case 'custom': {
        const state = runs.get(info.runId);
        if (!state) break;
        const open = state.systems.get(pairKey(event.system, event.entity));
        const target = open && !open.ended ? open.span : state.stepSpan;
        target?.addEvent('langecs.emit', {
          'langecs.emit.data': safeStringify(event.data, 8192),
        });
        break;
      }
      case 'step:applied': {
        const state = runs.get(info.runId);
        const span = state?.stepSpan;
        if (!state || !span) break;
        span.setAttributes({
          [ATTR_LANGECS_CHANGES_COUNT]: event.changes.length,
          [ATTR_LANGECS_SPAWNED_COUNT]: event.spawned.length,
          [ATTR_LANGECS_DESPAWNED_COUNT]: event.despawned.length,
        });
        if (captureChanges) {
          for (const change of event.changes) {
            span.addEvent('langecs.change', changeAttributes(change));
          }
        }
        span.end();
        if (state.stepStartedAt !== undefined) {
          stepDuration.record((now() - state.stepStartedAt) / 1000, {
            [ATTR_LANGECS_WORLD_ID]: info.worldId,
          });
        }
        state.stepSpan = undefined;
        state.stepContext = undefined;
        state.stepStartedAt = undefined;
        break;
      }
      case 'run:end': {
        const state = runs.get(info.runId);
        if (!state) break;
        runs.delete(info.runId);
        endLeftovers(state);
        state.runSpan.setAttributes({
          [ATTR_LANGECS_RUN_STATUS]: event.status,
          [ATTR_LANGECS_RUN_STEPS]: event.steps,
        });
        state.runSpan.setStatus(
          event.status === 'error' ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.OK },
        );
        state.runSpan.end();
        runDuration.record((now() - state.startedAt) / 1000, {
          [ATTR_LANGECS_WORLD_ID]: info.worldId,
          [ATTR_LANGECS_RUN_STATUS]: event.status,
        });
        break;
      }
      case 'run:reject': {
        // Barrier rejection: the run emits no run:end (R40) — close out here.
        const state = runs.get(info.runId);
        if (!state) break;
        runs.delete(info.runId);
        endLeftovers(state);
        state.runSpan.recordException(event.error);
        state.runSpan.setStatus({ code: SpanStatusCode.ERROR, message: event.error.message });
        state.runSpan.setAttribute(ATTR_ERROR_TYPE, event.error.name);
        state.runSpan.end();
        runDuration.record((now() - state.startedAt) / 1000, {
          [ATTR_LANGECS_WORLD_ID]: info.worldId,
          [ATTR_LANGECS_RUN_STATUS]: 'error',
        });
        break;
      }
      default:
        break; // system:start is covered by wrapSystemRun / system:error
    }
  };

  const wrapSystemRun = (info: SystemRunInfo, fn: () => Promise<void>): Promise<void> => {
    const state = runs.get(info.runId);
    if (!state) return fn(); // attached mid-run — stay out of the way (R46)
    const parent = state.stepContext ?? state.runContext;
    const startedAt = now();
    // startActiveSpan makes the system span the active context around fn, so
    // spans from user code inside the system nest under it (given a context
    // manager — see the module comment).
    return tracer.startActiveSpan(
      `langecs.system ${info.system}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: systemAttributes(info.system, info.entity, info.step),
      },
      parent,
      async (span) => {
        const open: OpenSystemSpan = { span, ended: false };
        state.systems.set(pairKey(info.system, info.entity), open);
        try {
          await fn();
          open.ended = true;
          span.end();
          systemDuration.record((now() - startedAt) / 1000, {
            [ATTR_LANGECS_SYSTEM_KEY]: info.system,
            error: false,
          });
        } catch (err) {
          open.ended = true;
          span.recordException(toException(err));
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
          span.setAttribute(ATTR_ERROR_TYPE, errorName(err));
          span.end();
          systemDuration.record((now() - startedAt) / 1000, {
            [ATTR_LANGECS_SYSTEM_KEY]: info.system,
            error: true,
          });
          systemErrors.add(1, { [ATTR_LANGECS_SYSTEM_KEY]: info.system });
          throw err; // R46: propagate the system's failure unchanged
        }
      },
    );
  };

  const detachObserver = world.observe({ onEvent, wrapSystemRun });

  // --- wrapResources: auto-instrument models and tools at registration time.
  let restoreRegister: (() => void) | undefined;
  if (wrapResources) {
    const maybeWrap = (name: string, value: unknown): unknown => {
      if (value === null || typeof value !== 'object') return value;
      const candidate = value as { name?: unknown; generate?: unknown; execute?: unknown };
      if (typeof candidate.generate === 'function') {
        return instrumentModel(value as Model, {
          model: name,
          tracerProvider: options.tracerProvider,
        });
      }
      // Matches the @langecs/stdlib registration shape: registerTools() puts a
      // ToolDef { name, description?, parameters?, needsApproval?, execute }
      // under the resource name `tool:<name>`. All other properties survive
      // (instrumentTool spreads the original).
      if (
        name.startsWith('tool:') &&
        typeof candidate.execute === 'function' &&
        typeof candidate.name === 'string'
      ) {
        return instrumentTool(value as { name: string; execute: (...args: never[]) => unknown }, {
          tracerProvider: options.tracerProvider,
        });
      }
      return value;
    };

    const target = world as World & { register: World['register'] };
    const hadOwnRegister = Object.hasOwn(world, 'register');
    const original = world.register;
    const patched = ((nameOrRef: string | ResourceRef<unknown>, value: unknown): void => {
      const name = typeof nameOrRef === 'string' ? nameOrRef : nameOrRef.resourceName;
      original.call(world, name, maybeWrap(name, value));
    }) as World['register'];
    target.register = patched;
    restoreRegister = () => {
      if (target.register !== patched) return; // re-patched by someone else — leave it
      if (hadOwnRegister) target.register = original;
      else delete (target as { register?: World['register'] }).register;
    };
  }

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    detachObserver();
    restoreRegister?.();
    entityGauge.removeCallback(observeEntities);
    for (const state of runs.values()) {
      endLeftovers(state);
      state.runSpan.end();
    }
    runs.clear();
  };
}
