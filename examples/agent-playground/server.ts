// An MCP server over live LangECS worlds: the protocol an OUTSIDE agent uses to
// inspect, diagnose, repair, run, cancel, resume, fork — and, when the host
// allows it, extend — a world. Every tool is a thin, bounded wrapper over the
// public World API and the §14 observer surface; nothing here bypasses engine
// invariants (idle-only mutation, R16) and nothing evaluates code a caller sent.
//
// Design notes (each was a review finding, see docs/agents-as-users.md):
// - `run` never blocks indefinitely and never fakes a terminal status: past its
//   response wait it answers `operationStatus: 'running'` with the same `runId`
//   to poll via `run_status`. A response timeout is not a cancellation; `cancel`
//   is a separate, explicit tool.
// - `edit` is ONE scoped operation per call and requires the caller to echo the
//   host `revision` it last saw. The revision moves on every external change and
//   every committed step (not `world.step`, which idle writes do not advance).
// - `explain` returns structured facts and retained evidence. It never evaluates
//   a `when` guard to answer "why not": a guard is code, and the recipe author's
//   note is the evidence a controller gets about what it checks.
// - `checkpoint fork` builds a NEW world from a snapshot with the exact recipe
//   (`forkFromSnapshot`); in-place rewind is not offered, because `load`
//   replaces entities, not installed systems.
// - `install` (declarative components / prompt systems) is off unless the host
//   opts in, and refuses while a run is in flight.

import {
  formatTrace,
  getComponentByName,
  listComponents,
  MemoryAdapter,
  type ObserverEvent,
  type Run,
  type RunResult,
  type Snapshot,
  type SystemInfo,
  type World,
} from '@langecs/core';
import {
  type AuthoringPolicy,
  type ComponentDecl,
  checkDeclaredWrite,
  declareComponent,
  declareSystem,
  forkFromSnapshot,
  Goal,
  narrateWorld,
  Phase,
  type PromptSystemDecl,
  ProposalRejected,
  promptLedger,
  Recipe,
  readRecipe,
  snapshotHasRecipe,
} from '@langecs/stdlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ------------------------------------------------------------------ types

export interface PlaygroundServerOptions {
  /**
   * Registers the hand-written recipe (systems + resources) on a fresh world,
   * in the original order — replayed for every fork (`forkFromSnapshot`).
   */
  build: (world: World) => void;
  /** Recipe author's notes per system key or name, returned by `explain`. */
  notes?: Record<string, string>;
  /** Enables `install` (declarative components and prompt systems). Default false. */
  allowAuthoring?: boolean;
  /**
   * Native (code-defined) components installed prompt systems may write or
   * remove. Declared components are always writable by them; a native one —
   * an application's `Approved` marker, say — is not, unless listed here.
   */
  allowNativeWrites?: string[];
  /** JSON values longer than this are truncated in tool results. Default 2000. */
  maxValueChars?: number;
  /** Upper bound for `waitMs` on run/run_status/resume. Default 60_000. */
  maxWaitMs?: number;
}

type Settled =
  | { kind: 'finished'; result: RunResult }
  | { kind: 'rejected'; error: { name: string; message: string } };

interface RunHandle {
  runId: string;
  run: Run;
  startedAt: number;
  /** `world.step` when the run started — tells committed progress from a rollback. */
  startStep: number;
  events: ObserverEvent[];
  settled?: Settled;
  done: Promise<void>;
}

export interface PlaygroundSession {
  id: string;
  world: World;
  adapter: MemoryAdapter;
  /** Host revision: +1 on every external change and every committed step. */
  revision: number;
  run?: RunHandle;
  detach: () => void;
}

export interface PlaygroundServer {
  server: McpServer;
  sessions: Map<string, PlaygroundSession>;
  /** The world tools address when no `world` argument is given. */
  active: () => PlaygroundSession;
  attach: (world: World, adapter: MemoryAdapter) => PlaygroundSession;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------- helpers

const MAX_EVENTS_PER_RUN = 2000;
const EVENTS_PER_PAGE = 200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorOf = (err: unknown): { name: string; message: string } =>
  err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'Error', message: String(err) };

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});

const failure = (err: unknown): CallToolResult => {
  const { name, message } = errorOf(err);
  return { isError: true, content: [{ type: 'text', text: `${name}: ${message}` }] };
};

/** Detached, size-bounded copy of a component value for a tool result. */
function bound(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= maxChars) return JSON.parse(text) as unknown;
  return { $truncated: true, chars: text.length, preview: text.slice(0, maxChars) };
}

/**
 * Builds component inits for an external write path (`edit`, `run` input).
 *
 * `Recipe` is refused on EVERY such path: it is the authoring boundary, and a
 * host that did not enable `install` must not have it opened by a plain `set`
 * or spawn — a stored manifest is executable the moment a fork hydrates it.
 * Values of DECLARED components are checked against their schema (and, for an
 * `add` on a reducer component, against the merged result) the same way a
 * prompt system's proposal is, so an operator cannot store what a system could
 * not have proposed.
 */
/** Size-bounded text for narration and free-form strings in tool results. */
const clipTextTo = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}… [${text.length - maxChars} more chars]`;

function initsFrom(
  specs: { component: string; value?: unknown }[],
  current?: (name: string) => unknown,
) {
  return specs.map((spec) => {
    const type = getComponentByName(spec.component);
    if (type === undefined) {
      const known = listComponents()
        .map((c) => c.name)
        .filter((n) => !n.startsWith('agent:'))
        .join(', ');
      throw new Error(`Unknown component "${spec.component}". Known: ${known}`);
    }
    if (spec.component === Recipe.componentName) {
      throw new Error(
        `"${Recipe.componentName}" cannot be written through edit or run input: declarations go ` +
          'through the install tool, which the host must enable (--allow-authoring).',
      );
    }
    const value = spec.value === undefined ? true : spec.value;
    const violations = checkDeclaredWrite(spec.component, value, current?.(spec.component));
    if (violations.length > 0) {
      throw new Error(`Invalid value for "${spec.component}": ${violations.join('; ')}`);
    }
    return type(value);
  });
}

// ----------------------------------------------------------------- server

export function createPlaygroundServer(
  initial: { world: World; adapter: MemoryAdapter },
  opts: PlaygroundServerOptions,
): PlaygroundServer {
  const maxValueChars = opts.maxValueChars ?? 2000;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const clipText = (text: string): string => clipTextTo(text, maxValueChars);
  const clip = (value: unknown): unknown => bound(value, maxValueChars);
  const notes = opts.notes ?? {};
  const sessions = new Map<string, PlaygroundSession>();
  let activeId = initial.world.id;
  // Monotonic: `Date.now()` alone produced duplicate ids for runs started within
  // one millisecond, and a stale handle then aliased a newer run under run_status.
  let runCounter = 0;

  const policy: AuthoringPolicy = { allowNative: opts.allowNativeWrites ?? [] };

  const attach = (world: World, adapter: MemoryAdapter): PlaygroundSession => {
    // Register the ledger BEFORE observing: `inspect ledger` must be a pure read,
    // not the call that first creates a resource and bumps the revision.
    promptLedger(world);
    const session: PlaygroundSession = {
      id: world.id,
      world,
      adapter,
      revision: 0,
      detach: () => {},
    };
    session.detach = world.observe({
      onEvent: (event) => {
        const handle = session.run;
        if (handle !== undefined && handle.events.length < MAX_EVENTS_PER_RUN)
          handle.events.push(event);
        if (
          event.type === 'step:applied' ||
          event.type === 'run:end' ||
          event.type === 'run:reject'
        ) {
          session.revision += 1;
        }
      },
      onExternalChange: () => {
        session.revision += 1;
      },
    });
    sessions.set(session.id, session);
    return session;
  };
  attach(initial.world, initial.adapter);

  const session = (id?: string): PlaygroundSession => {
    const found = sessions.get(id ?? activeId);
    if (found === undefined) {
      throw new Error(
        `Unknown world "${id ?? activeId}". Known: ${[...sessions.keys()].join(', ')}`,
      );
    }
    return found;
  };

  const assertIdle = (s: PlaygroundSession, what: string): void => {
    if (s.world.running) {
      throw new Error(
        `Cannot ${what}: a run is in flight (runId ${s.run?.runId ?? '?'}). Poll run_status, or cancel.`,
      );
    }
  };

  const assertRevision = (s: PlaygroundSession, revision: number): void => {
    if (revision !== s.revision) {
      throw new Error(
        `Stale revision ${revision}: the world is at revision ${s.revision}. Re-inspect, then retry with the current revision.`,
      );
    }
  };

  // ------------------------------------------------------------- run handles

  const startRun = (s: PlaygroundSession, start: () => Run): RunHandle => {
    if (s.run !== undefined && s.run.settled === undefined) {
      throw new Error(`A run is already in flight (runId ${s.run.runId}); poll run_status.`);
    }
    const previous = s.run;
    const handle: RunHandle = {
      runId: `${s.id}:run-${++runCounter}`,
      run: undefined as unknown as Run,
      startedAt: Date.now(),
      startStep: s.world.step,
      events: [],
      done: Promise.resolve(),
    };
    // The recording slot is installed BEFORE the engine starts: run:start,
    // step:start and system:start emit synchronously inside `run()`, and a slot
    // assigned afterwards lost them (or appended them to the previous handle).
    s.run = handle;
    try {
      handle.run = start(); // throws WorldRunningError if the engine disagrees (R25)
    } catch (err) {
      s.run = previous;
      throw err;
    }
    // `Run` is PromiseLike (R40); wrap it so the handle owns a real Promise.
    handle.done = Promise.resolve(handle.run).then(
      (result) => {
        handle.settled = { kind: 'finished', result };
      },
      (err: unknown) => {
        handle.settled = { kind: 'rejected', error: errorOf(err) };
      },
    );
    return handle;
  };

  const traceTail = (s: PlaygroundSession, steps = 3): string =>
    clipText(formatTrace(s.world.getTrace().slice(-steps)));

  const runReport = (s: PlaygroundSession, handle: RunHandle, cursor: number) => {
    const events = handle.events
      .slice(cursor, cursor + EVENTS_PER_PAGE)
      .map((event) => bound(event, maxValueChars));
    const base = {
      runId: handle.runId,
      world: s.id,
      revision: s.revision,
      committedStep: s.world.step,
      elapsedMs: Date.now() - handle.startedAt,
      events,
      eventCursor: cursor + events.length,
      eventsRemaining: Math.max(0, handle.events.length - (cursor + events.length)),
      traceTail: traceTail(s),
    };
    if (handle.settled === undefined) {
      return {
        operationStatus: 'running' as const,
        ...base,
        runningPairs: s.world.runningPairs(),
        note: 'Still running. Poll run_status with this runId; the world is busy, edits are rejected until it settles. cancel stops it.',
      };
    }
    if (handle.settled.kind === 'rejected') {
      const committed = s.world.step - handle.startStep;
      return {
        operationStatus: 'rejected' as const,
        ...base,
        error: handle.settled.error,
        committedStepsThisRun: committed,
        note:
          `${committed > 0 ? `${committed} step(s) of this run committed before the failure. ` : ''}` +
          'A barrier rejection (WriteConflictError, a throwing reducer, an unknown invalidate) commits ' +
          'nothing from the failing step and leaves its dirt intact, so running again reproduces it (R30). ' +
          'A persistence failure (adapter.save) is different: that step committed and only the save ' +
          'failed (R37). Read committedStepsThisRun and the error name before deciding.',
      };
    }
    return {
      operationStatus: 'finished' as const,
      ...base,
      result: handle.settled.result,
      narration: narrateWorld(s.world).map((n) => clipText(n.sentence)),
    };
  };

  const awaitRun = async (
    s: PlaygroundSession,
    handle: RunHandle,
    waitMs: number,
    cursor: number,
  ) => {
    const wait = Math.max(0, Math.min(waitMs, maxWaitMs));
    if (handle.settled === undefined) await Promise.race([handle.done, sleep(wait)]);
    return runReport(s, handle, cursor);
  };

  // ------------------------------------------------------------------ views

  const entityView = (s: PlaygroundSession, id: number) => {
    const handle = s.world.entity(id);
    if (handle === undefined) throw new Error(`Unknown entity ${id}.`);
    const components: Record<string, unknown> = {};
    for (const name of handle.components()) {
      const type = getComponentByName(name);
      components[name] = type === undefined ? null : bound(handle.get(type), maxValueChars);
    }
    const snapshot = s.world.snapshot();
    return {
      id,
      components,
      agents: handle
        .components()
        .filter((n) => n.startsWith('agent:'))
        .map((n) => n.slice(6)),
      matchingSystems: s.world.systemsMatching(id).map((sys) => sys.key),
      pendingPairs: snapshot.pendingPairs.filter((p) => p.entity === id),
      interrupts: clip(s.world.pending().find((p) => p.entity === id)?.interrupts ?? []),
      rejectedProposals: clip(handle.get(ProposalRejected) ?? []),
    };
  };

  const summaryView = (s: PlaygroundSession) => {
    const snapshot = s.world.snapshot();
    return {
      world: s.id,
      activeWorld: activeId,
      worlds: [...sessions.keys()],
      revision: s.revision,
      step: s.world.step,
      running: s.world.running,
      runId: s.run?.runId,
      entityCount: snapshot.entities.length,
      systems: s.world.systems().map((sys) => sys.key),
      pendingPairs: snapshot.pendingPairs,
      interrupts: clip(s.world.pending()),
      runningPairs: s.world.runningPairs(),
      narration: narrateWorld(s.world).map((n) => clipText(n.sentence)),
      authoring: opts.allowAuthoring === true,
      how: 'inspect → explain(entity, system) → edit(revision, one op) → run → run_status/resume/cancel → checkpoint(history|fork).',
    };
  };

  const explain = (s: PlaygroundSession, entityId: number, systemName: string) => {
    const info: SystemInfo | undefined = s.world
      .systems()
      .find((sys) => sys.key === systemName || sys.name === systemName);
    if (info === undefined) {
      throw new Error(
        `Unknown system "${systemName}". Known: ${s.world
          .systems()
          .map((x) => x.key)
          .join(', ')}`,
      );
    }
    const handle = s.world.entity(entityId);
    if (handle === undefined) throw new Error(`Unknown entity ${entityId}.`);
    const present = new Set(handle.components());
    const missing = info.query.include.filter((n) => !present.has(n));
    const blocking = info.query.exclude.filter((n) => present.has(n));
    const matches = missing.length === 0 && blocking.length === 0;
    const pending = s.world
      .snapshot()
      .pendingPairs.find((p) => p.entity === entityId && p.system === info.key);
    const running = s.world
      .runningPairs()
      .find((p) => p.entity === entityId && p.system === info.key);

    const trace = s.world.getTrace();
    let lastRan: { step: number; ms: number; error?: unknown } | undefined;
    let lastVetoed: { step: number } | undefined;
    // Recency is trace POSITION, not the step label: a veto-only iteration
    // reuses the number of the step a later run then commits (R42,
    // `committed: false`), so labels can repeat.
    let ranAt = -1;
    let vetoedAt = -1;
    trace.forEach((step, index) => {
      const ran = step.runs.find((r) => r.system === info.key && r.entity === entityId);
      if (ran !== undefined) {
        lastRan = {
          step: step.step,
          ms: ran.ms,
          ...(ran.error ? { error: clip(ran.error) } : {}),
        };
        ranAt = index;
      }
      if (step.vetoed.some((v) => v.system === info.key && v.entity === entityId)) {
        lastVetoed = { step: step.step };
        vetoedAt = index;
      }
    });
    const coverage =
      trace.length === 0
        ? null
        : { from: trace[0]?.step ?? 0, to: trace[trace.length - 1]?.step ?? 0 };

    let verdict: string;
    if (running !== undefined) {
      verdict = `Executing right now (step ${running.step}, ${Math.round(running.elapsedMs)}ms so far${running.abandoned ? ', abandoned by the barrier after its timeout' : ''}).`;
    } else if (!matches) {
      verdict =
        `Does not match. ${missing.length > 0 ? `Missing positive term(s): ${missing.join(', ')}. ` : ''}` +
        `${blocking.length > 0 ? `Blocked by exclusion(s) present on the entity: ${blocking.join(', ')}. ` : ''}` +
        'Adding the missing / removing the blocking components makes the query newly match, which is dirt (R26).';
    } else if (pending !== undefined) {
      verdict = `Matched and dirty (reason: ${pending.reason}): it will be a candidate at the next step.`;
    } else if (lastVetoed !== undefined && vetoedAt > ranAt) {
      verdict =
        `Matched but not scheduled: its guard vetoed at step ${lastVetoed.step} and the veto consumed the dirt (R26). ` +
        'Guards are not evaluated here — read the system note. A new foreign change to a queried component ' +
        `(${info.query.include.join(', ')}) re-arms it.`;
    } else if (lastRan !== undefined) {
      verdict =
        `Matched, idle: it last ran at step ${lastRan.step}${lastRan.error ? ' and threw' : ''}, and nothing it queries changed since. ` +
        'Its own writes never re-trigger it (R26 self-write exclusion).';
    } else {
      verdict =
        'Matched, idle, and never scheduled within the retained trace: no pending dirt. Dirt arises only from a ' +
        `foreign write to ${info.query.include.join(', ')}, a new match, or an external change.`;
    }

    return {
      system: { ...info, note: notes[info.key] ?? notes[info.name] ?? null },
      entity: { id: entityId, components: [...present] },
      match: { matches, missing, blocking },
      scheduling: { pendingReason: pending?.reason ?? null, running: running ?? null },
      history: {
        lastRan: lastRan ?? null,
        lastVetoed: lastVetoed ?? null,
        traceCovers: coverage,
        caveat:
          'Evidence comes from the retained flight recorder only (ring buffer; cleared by load). Absence of evidence is not evidence of absence.',
      },
      verdict,
    };
  };

  // ------------------------------------------------------------------ tools

  const server = new McpServer(
    { name: 'langecs-playground', version: '0.1.0' },
    {
      instructions:
        'You are operating a live LangECS world: entities carry components (plain JSON), systems fire when the ' +
        'components they query change, a run steps until nothing fires (quiescence). Work loop: inspect (summary, ' +
        'entities, entity) → explain(entity, system) when something did not fire → edit(revision, ONE operation) ' +
        '→ run (bounded wait; poll run_status by runId while it reports running) → resume interrupts / cancel → ' +
        'checkpoint history|fork to branch from an earlier step. Edits need the current revision from inspect. ' +
        "A rejected run's failing step committed nothing (earlier steps of that run did); read the error and committedStepsThisRun, fix the cause, run again.",
    },
  );

  const worldArg = z.string().optional().describe('World id (default: the active world).');

  server.registerTool(
    'inspect',
    {
      title: 'Inspect the world',
      description:
        'Read-only views: summary (revision, step, pending pairs, interrupts, narration), entities (paged), ' +
        'entity (components, matching systems, pending dirt, errors, interrupts), systems (queries + stats), ' +
        'trace (flight recorder tail), ledger (prompt-system model calls), recipe (declared vocabulary).',
      inputSchema: {
        world: worldArg,
        view: z.enum(['summary', 'entities', 'entity', 'systems', 'trace', 'ledger', 'recipe']),
        entity: z.number().int().optional().describe('For view=entity.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Page size for entities/trace (default 50/5).'),
        offset: z.number().int().min(0).optional().describe('Page offset for entities.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const s = session(args.world);
        switch (args.view) {
          case 'summary':
            return json(summaryView(s));
          case 'entities': {
            const all = s.world.query();
            const offset = args.offset ?? 0;
            const limit = args.limit ?? 50;
            return json({
              world: s.id,
              revision: s.revision,
              total: all.length,
              offset,
              entities: all.slice(offset, offset + limit).map((h) => ({
                id: h.id,
                components: h.components(),
                agents: h
                  .components()
                  .filter((n) => n.startsWith('agent:'))
                  .map((n) => n.slice(6)),
                phase: clip(h.get(Phase) ?? null),
                goal: clip(h.get(Goal) ?? null),
              })),
            });
          }
          case 'entity': {
            if (args.entity === undefined) throw new Error('view=entity needs "entity".');
            return json({ world: s.id, revision: s.revision, ...entityView(s, args.entity) });
          }
          case 'systems': {
            const stats = new Map(s.world.queryStats().map((q) => [q.key, q]));
            return json({
              world: s.id,
              systems: s.world.systems().map((sys) => ({
                ...sys,
                note: notes[sys.key] ?? notes[sys.name] ?? null,
                stats: stats.get(sys.key) ?? null,
              })),
              components: listComponents(),
            });
          }
          case 'trace': {
            const steps = s.world.getTrace().slice(-(args.limit ?? 5));
            return json({
              world: s.id,
              steps: steps.map((st) => bound(st, maxValueChars * 4)),
              text: clipText(formatTrace(steps)),
            });
          }
          case 'ledger':
            return json({ world: s.id, attempts: clip(promptLedger(s.world).attempts) });
          case 'recipe':
            return json({ world: s.id, recipe: clip(readRecipe(s.world)) });
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'explain',
    {
      title: 'Explain why a system did or did not fire for an entity',
      description:
        'Structured facts: whether the query matches (missing positive terms, blocking exclusions), pending dirt, ' +
        'in-flight execution, and retained trace evidence (last run, last guard veto). Never evaluates guards.',
      inputSchema: {
        world: worldArg,
        entity: z.number().int(),
        system: z.string().describe('System key (e.g. "assignLow" or "agent:system").'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return json(explain(session(args.world), args.entity, args.system));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'edit',
    {
      title: 'Apply one external mutation (idle only)',
      description:
        'One operation per call: spawn (components), add/set/remove (entity + component [+ value]), despawn. ' +
        'Requires the current revision from inspect; rejected while a run is in flight (R16). add merges through ' +
        'a reducer when the component has one; set replaces; a tag takes no value.',
      inputSchema: {
        world: worldArg,
        revision: z.number().int().describe('The revision you last observed.'),
        op: z.enum(['spawn', 'add', 'set', 'remove', 'despawn']),
        entity: z.number().int().optional(),
        component: z.string().optional(),
        value: z.unknown().optional(),
        components: z
          .array(z.object({ component: z.string(), value: z.unknown().optional() }))
          .optional()
          .describe('For spawn: the initial components.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      try {
        const s = session(args.world);
        assertIdle(s, 'edit');
        assertRevision(s, args.revision);
        switch (args.op) {
          case 'spawn': {
            if (args.components === undefined || args.components.length === 0) {
              throw new Error('spawn needs "components".');
            }
            const handle = s.world.spawn(...initsFrom(args.components));
            return json({ ok: true, entity: handle.id, revision: s.revision });
          }
          case 'despawn': {
            if (args.entity === undefined) throw new Error('despawn needs "entity".');
            const handle = s.world.entity(args.entity);
            if (handle === undefined) throw new Error(`Unknown entity ${args.entity}.`);
            if (handle.has(Recipe)) {
              throw new Error(
                `Entity ${args.entity} carries the world's ${Recipe.componentName}; despawning it ` +
                  'would silently drop every declaration a fork depends on. There is no reset route ' +
                  'through edit — start a fresh world instead.',
              );
            }
            handle.despawn();
            return json({ ok: true, revision: s.revision });
          }
          default: {
            if (args.entity === undefined || args.component === undefined) {
              throw new Error(`${args.op} needs "entity" and "component".`);
            }
            const handle = s.world.entity(args.entity);
            if (handle === undefined) throw new Error(`Unknown entity ${args.entity}.`);
            if (args.op === 'remove' && args.component === Recipe.componentName) {
              throw new Error(
                `"${Recipe.componentName}" cannot be removed through edit: it is the manifest every ` +
                  'fork of this world is compiled from.',
              );
            }
            const [init] =
              args.op === 'remove'
                ? [{ component: getComponentByName(args.component), value: true }]
                : initsFrom([{ component: args.component, value: args.value }], (name) => {
                    // `add` merges through the reducer: validate the merged result.
                    const type = getComponentByName(name);
                    return args.op === 'add' && type !== undefined && handle.has(type)
                      ? handle.get(type)
                      : undefined;
                  });
            if (init === undefined || init.component === undefined) {
              throw new Error(`Unknown component "${args.component}".`);
            }
            if (args.op === 'remove') handle.remove(init.component);
            else if (args.op === 'add') handle.add(init.component, init.value);
            else handle.set(init.component, init.value);
            return json({
              ok: true,
              revision: s.revision,
              entity: entityView(s, args.entity),
            });
          }
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  const runInput = {
    world: worldArg,
    entity: z.number().int().optional().describe('With input: the entity to send to (world.send).'),
    input: z
      .array(z.object({ component: z.string(), value: z.unknown().optional() }))
      .optional()
      .describe('Components to add to `entity` before running (external adds, R25).'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Step cap for this run (default: the world recursionLimit).'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Response wait (default 5000). Not a deadline: past it you get operationStatus running.',
      ),
  };

  server.registerTool(
    'run',
    {
      title: 'Run the world to quiescence (bounded response wait)',
      description:
        'Starts a run (optionally after adding input components to an entity) and waits up to waitMs. Returns ' +
        'operationStatus finished | rejected | running. While running, poll run_status with the runId; use cancel to stop.',
      inputSchema: runInput,
    },
    async (args) => {
      try {
        const s = session(args.world);
        const handle = startRun(s, () => {
          if (args.input !== undefined && args.input.length > 0) {
            if (args.entity === undefined) throw new Error('input needs "entity".');
            const target = s.world.entity(args.entity);
            if (target === undefined) throw new Error(`Unknown entity ${args.entity}.`);
            const inits = initsFrom(args.input, (name) => {
              const type = getComponentByName(name);
              return type !== undefined && target.has(type) ? target.get(type) : undefined;
            });
            // The same external adds `world.send` performs (R25), but through
            // `run({ limit })` so a requested step cap is honoured with input too.
            for (const init of inits) target.add(init.component, init.value);
          }
          return s.world.run(args.limit === undefined ? undefined : { limit: args.limit });
        });
        return json(await awaitRun(s, handle, args.waitMs ?? 5000, 0));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'run_status',
    {
      title: 'Poll a run',
      description:
        'The latest report for the current run: events since cursor, running pairs, the result or rejection once settled.',
      inputSchema: {
        world: worldArg,
        runId: z.string().optional(),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('eventCursor from the previous report.'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Wait for settlement up to this long (default 0).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const s = session(args.world);
        const handle = s.run;
        if (handle === undefined) throw new Error('No run has been started on this world yet.');
        if (args.runId !== undefined && args.runId !== handle.runId) {
          throw new Error(`Unknown runId ${args.runId}; the latest run is ${handle.runId}.`);
        }
        return json(await awaitRun(s, handle, args.waitMs ?? 0, args.cursor ?? 0));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'cancel',
    {
      title: 'Cancel the world',
      description:
        'world.cancel(reason): aborts every in-flight pair signal and stamps Cancelled on every entity at the next ' +
        'boundary (R50). Cooperative: a system that ignores its signal finishes; a per-system timeoutMs is the hard bound.',
      inputSchema: { world: worldArg, reason: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const s = session(args.world);
        s.world.cancel(args.reason);
        return json({
          ok: true,
          running: s.world.running,
          revision: s.revision,
          runId: s.run?.runId ?? null,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'resume',
    {
      title: 'Answer a pending interrupt and run',
      description:
        'world.resume(entity, value): removes AwaitingHuman, sets HumanResponse({ value }), runs (R33). The trusted ' +
        'path for approvals — prompt systems cannot write HumanResponse themselves. Same bounded-wait report as run.',
      inputSchema: {
        world: worldArg,
        entity: z.number().int(),
        value: z
          .unknown()
          .describe('The answer, e.g. true or {"approved": false, "reason": "..."}.'),
        waitMs: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      try {
        const s = session(args.world);
        const handle = startRun(s, () => s.world.resume(args.entity, args.value));
        return json(await awaitRun(s, handle, args.waitMs ?? 5000, 0));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'History, fork, list and switch worlds',
      description:
        'history: the steps the world adapter kept. fork: build a NEW world from the snapshot at `step` with the exact ' +
        'recipe (hand-written systems + declared vocabulary) and make it active. list/activate manage the worlds this ' +
        'server holds. In-place rewind is deliberately not offered.',
      inputSchema: {
        world: worldArg,
        action: z.enum(['history', 'fork', 'list', 'activate']),
        step: z.number().int().optional().describe('For fork: the step to branch from.'),
        id: z
          .string()
          .optional()
          .describe('For fork: the new world id (default derived); for activate: the world id.'),
      },
    },
    async (args) => {
      try {
        const s = session(args.world);
        switch (args.action) {
          case 'history':
            return json({ world: s.id, steps: await s.adapter.history(s.id) });
          case 'list':
            return json({
              active: activeId,
              worlds: [...sessions.values()].map((x) => ({
                id: x.id,
                step: x.world.step,
                running: x.world.running,
                revision: x.revision,
              })),
            });
          case 'activate': {
            if (args.id === undefined) throw new Error('activate needs "id".');
            session(args.id);
            activeId = args.id;
            return json({ active: activeId });
          }
          case 'fork': {
            if (args.step === undefined) throw new Error('fork needs "step".');
            assertIdle(s, 'fork');
            const snapshot: Snapshot | null = await s.adapter.loadStep(s.id, args.step);
            if (snapshot === null)
              throw new Error(`No snapshot at step ${args.step} for world "${s.id}".`);
            const id = args.id ?? `${s.id}@${args.step}-${(sessions.size + 1).toString(36)}`;
            if (sessions.has(id)) throw new Error(`World "${id}" already exists.`);
            if (opts.allowAuthoring !== true && snapshotHasRecipe(snapshot)) {
              throw new Error(
                `The snapshot at step ${args.step} carries declared components or prompt systems; ` +
                  'this server was started without --allow-authoring, so it will not compile them.',
              );
            }
            const adapter = new MemoryAdapter();
            const world = forkFromSnapshot({
              snapshot,
              build: opts.build,
              id,
              persistence: adapter,
              hydrate: opts.allowAuthoring === true,
              policy,
            });
            const forked = attach(world, adapter);
            activeId = id;
            return json({ ok: true, active: activeId, world: summaryView(forked) });
          }
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  if (opts.allowAuthoring === true) {
    server.registerTool(
      'install',
      {
        title: 'Declare a component or a prompt system (data-only authoring)',
        description:
          'kind=component: { name, description?, schema?, tag?, reducer?: append|merge|sum|last-wins, max? }. ' +
          'kind=system: { name, description?, query: [names], not?, reads?, writes?, removes?, model: resourceName, ' +
          'prompt, agent?, timeoutMs?, maxOutputTokens?, maxRuns?, haltOnRejection? }. A prompt system may only write/remove ' +
          'the components it declares on the entity it matched; reserved control/capability components are refused; ' +
          'a malformed model reply becomes ProposalRejected state, not an exception. Declarations are recorded in the ' +
          'world Recipe so forks and restores carry them. Idle only.',
        inputSchema: {
          world: worldArg,
          kind: z.enum(['component', 'system']),
          decl: z.record(z.string(), z.unknown()),
        },
      },
      async (args) => {
        try {
          const s = session(args.world);
          assertIdle(s, 'install');
          if (args.kind === 'component') {
            declareComponent(s.world, args.decl as unknown as ComponentDecl);
          } else {
            const decl = args.decl as unknown as PromptSystemDecl;
            if (typeof decl.model === 'string' && !s.world.resources().includes(decl.model)) {
              throw new Error(
                `Model resource "${decl.model}" is not registered on this world. Available: ${s.world.resources().join(', ')}`,
              );
            }
            declareSystem(s.world, decl, policy);
          }
          return json({
            ok: true,
            revision: s.revision,
            recipe: clip(readRecipe(s.world)),
            systems: s.world.systems().map((x) => x.key),
          });
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  const close = async (): Promise<void> => {
    for (const s of sessions.values()) s.detach();
    await server.close();
  };

  return { server, sessions, active: () => session(), attach, close };
}
