// Multi-agent supervisor choreography (LangECS port of LangGraph.js
// examples/multi_agent/agent_supervisor.ipynb).
//
// Entities: one supervisor + two workers (researcher, writer). The supervisor
// decomposes the user request into per-worker `Task` components in a single
// model call; both workers then match `[Task, Role, ModelRef]` in the SAME
// step and run in parallel, reporting back by appending to the supervisor's
// `Inbox` (reducer fan-in, deterministic at the barrier). When all expected
// results are in, the supervisor aggregates them into the final answer.
//
// Two extra tricks the original cannot do:
//   - the writer is not pre-spawned: the supervisor creates it mid-run via
//     `ctx.spawn(writer, Task(...))` (dynamic agent spawning, R29/R34);
//   - a global `heal` system watches `[SystemError, Task]` — a crashed worker
//     is just state, and `ctx.invalidate` re-arms the failed pair (R24/R31/R32).

import {
  type AgentDef,
  defineAgent,
  defineComponent,
  defineSystem,
  type EntityHandle,
  type Model,
  type ModelRequest,
  type Msg,
  Not,
  type SystemCtx,
  SystemError,
  type World,
} from '@langecs/core';
import { extractJson, Inbox, Messages, MessageWaiting, ModelRef } from '@langecs/stdlib';

// ---------------------------------------------------------------- components

/** A unit of work assigned by the supervisor; the worker removes it when done. */
export const Task = defineComponent<{ from: number; instructions: string }>({ name: 'Task' });

/** What a worker is: `title` lands in Inbox `from`, `prompt` is its system prompt. */
export const Role = defineComponent<{ title: string; prompt: string }>({ name: 'Role' });

/** Present while the supervisor awaits worker results; `expect` = result count. */
export const Dispatched = defineComponent<{ expect: number }>({ name: 'Dispatched' });

// ------------------------------------------------------------------- helpers

/** Calls the entity's model, streaming tokens to the live event stream (R23). */
async function callModel(
  ctx: SystemCtx,
  ref: string,
  who: string,
  req: ModelRequest,
): Promise<Msg> {
  const model = ctx.resource<Model>(ref);
  const result = model.stream
    ? await model.stream(req, (chunk) => {
        if (chunk.text !== undefined && chunk.text.length > 0) {
          ctx.emit({ kind: 'token', who, text: chunk.text });
        }
      })
    : await model.generate(req);
  return result.message;
}

/** The supervisor's routing decision: a task for each worker that's needed. */
type Routing = { researcher?: string; writer?: string };

/**
 * Validates the supervisor's routing JSON: each present task must be a
 * non-empty string, and at least one worker must be assigned. Throwing here
 * feeds `extractJson`'s single retry — a fumbled first answer self-corrects —
 * instead of the old tolerant hand-parser silently assigning the raw request to
 * everyone. (Plug a schema library here in real code; this stays dependency-free.)
 */
function validateRouting(parsed: unknown): Routing {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('expected a JSON object like {"researcher": "...", "writer": "..."}');
  }
  const { researcher, writer } = parsed as Record<string, unknown>;
  const out: Routing = {};
  if (typeof researcher === 'string' && researcher.trim().length > 0) out.researcher = researcher;
  if (typeof writer === 'string' && writer.trim().length > 0) out.writer = writer;
  if (out.researcher === undefined && out.writer === undefined) {
    throw new Error('assign a task to at least one worker: "researcher" and/or "writer".');
  }
  return out;
}

const ROUTING_SCHEMA = {
  type: 'object',
  properties: {
    researcher: { type: 'string', description: 'task for the researcher (facts/background)' },
    writer: { type: 'string', description: 'task for the writer (polished prose)' },
  },
};

// ------------------------------------------------------------------- workers

/**
 * The single worker system, shared by both worker agents. Auto-tag narrowing
 * (R34) registers it as `researcher:work` and `writer:work`; a `Task` arriving
 * (newly-matched dirt) is what wakes a worker.
 */
const work = defineSystem({
  name: 'work',
  query: [Task, Role, ModelRef],
  run: async (e, ctx) => {
    const task = e.get(Task);
    const role = e.get(Role);
    const reply = await callModel(ctx, e.get(ModelRef), role.title, {
      system: role.prompt,
      messages: [{ role: 'user', content: task.instructions }],
    });
    // Report back: Inbox has an append reducer, so concurrent workers merge
    // deterministically at the barrier instead of conflicting (R30).
    ctx.write(task.from, Inbox, [{ from: role.title, content: reply.content }], 'add');
    e.remove(Task);
  },
});

export const researcher: AgentDef = defineAgent({
  name: 'researcher',
  components: [
    Role({
      title: 'researcher',
      prompt:
        'You are a researcher. Produce 3-5 crisp factual bullet points for the task. ' +
        'No preamble, no conclusions — just the facts.',
    }),
    ModelRef('model:researcher'),
  ],
  systems: [work],
});

export const writer: AgentDef = defineAgent({
  name: 'writer',
  components: [
    Role({
      title: 'writer',
      prompt:
        'You are a writer. Produce a short, polished piece of prose for the task. ' +
        'At most one paragraph.',
    }),
    ModelRef('model:writer'),
  ],
  systems: [work],
});

// ---------------------------------------------------------------- supervisor

const ROUTING_PROMPT =
  'You are a supervisor coordinating two workers:\n' +
  '- researcher: finds facts and background.\n' +
  '- writer: produces polished prose.\n' +
  'Decompose the user request into one task per worker. Omit a worker only if it ' +
  'is truly not needed (but assign at least one).';

const AGGREGATE_PROMPT =
  'You are a supervisor. Your workers have reported their results. Compose the ' +
  'final answer to the user request from those results. Be concise.';

/**
 * Routes the request: one model call decides both tasks, then BOTH workers are
 * dispatched in the same barrier — the researcher via a `Task` write, the
 * writer by spawning a whole agent at runtime. Both pairs become dirty for the
 * next step, so the workers run in parallel.
 */
const plan = defineSystem({
  name: 'plan',
  query: [Messages, ModelRef, MessageWaiting, Not(Dispatched)],
  when: (e) => e.get(Messages).some((m) => m.role === 'user'),
  run: async (e, ctx) => {
    const messages = e.get(Messages);
    // Typed, validated structured output: extractJson enforces the schema and
    // retries once on a bad reply — no tolerant hand-parsing, no silent fallback.
    const model = ctx.resource<Model>(e.get(ModelRef));
    const tasks = await extractJson(
      model,
      { system: ROUTING_PROMPT, schema: ROUTING_SCHEMA, schemaName: 'Routing', messages },
      validateRouting,
    );

    let expect = 0;
    if (tasks.researcher !== undefined) {
      // The researcher is a long-lived entity; assign work to the existing one
      // (or spawn it if this world somehow lacks one).
      const target = ctx.world.query(researcher.tag)[0] ?? ctx.spawn(researcher);
      ctx.write(target, Task, { from: e.id, instructions: tasks.researcher }, 'set');
      expect += 1;
      ctx.emit({ kind: 'dispatch', to: 'researcher', entity: target.id, task: tasks.researcher });
    }
    if (tasks.writer !== undefined) {
      // Dynamic spawning: the writer agent (components + scoped systems) joins
      // the world mid-run, with its Task already attached.
      const spawned = ctx.spawn(writer, Task({ from: e.id, instructions: tasks.writer }));
      expect += 1;
      ctx.emit({
        kind: 'dispatch',
        to: 'writer',
        entity: spawned.id,
        task: tasks.writer,
        spawned: true,
      });
    }

    // Keep the routing decision in the conversation record.
    e.add(Messages, [{ role: 'assistant', content: JSON.stringify(tasks) }]);
    e.set(Dispatched, { expect });
  },
});

/**
 * Fires every time the supervisor's Inbox changes (worker fan-in is foreign
 * dirt); the `when` guard vetoes until all expected results have arrived, then
 * one model call composes the final answer and the request cycle is closed.
 */
const aggregate = defineSystem({
  name: 'aggregate',
  query: [Inbox, Dispatched, Messages, ModelRef, MessageWaiting],
  when: (e) => e.get(Inbox).length >= e.get(Dispatched).expect,
  run: async (e, ctx) => {
    const findings = e.get(Inbox);
    const block = findings.map((f) => `### ${f.from}\n${f.content}`).join('\n\n');
    const reply = await callModel(ctx, e.get(ModelRef), 'supervisor', {
      system: AGGREGATE_PROMPT,
      messages: [
        ...e.get(Messages),
        {
          role: 'user',
          content: `Worker results:\n\n${block}\n\nNow write the final answer to my original request.`,
        },
      ],
    });
    e.add(Messages, [reply]);
    e.set(Inbox, []); // consume the findings (set bypasses the append reducer)
    e.remove(Dispatched); // re-arms `plan` for the next request
    e.remove(MessageWaiting); // answer delivered -> quiescence
  },
});

export const supervisor: AgentDef = defineAgent({
  name: 'supervisor',
  components: [Messages([]), Inbox([]), ModelRef('model:supervisor')],
  systems: [plan, aggregate],
});

// ------------------------------------------------------------------- healing

/** Give a failing (system, entity) pair this many chances before giving up. */
export const MAX_HEAL_ATTEMPTS = 2;

/**
 * Failure is state: when a worker's `run` throws, the engine appends a
 * `SystemError` record to the entity (R31) — which makes this global system
 * newly match `[SystemError, Task]` (the task is still unfinished). It re-arms
 * the failed pair with `ctx.invalidate`; a later success auto-clears the
 * records (R32), unmatching this system again.
 */
export const heal = defineSystem({
  name: 'heal',
  query: [SystemError, Task],
  run: (e, ctx) => {
    const failures = new Map<string, number>();
    for (const record of e.get(SystemError)) {
      failures.set(record.system, (failures.get(record.system) ?? 0) + 1);
    }
    for (const [system, count] of failures) {
      if (count > MAX_HEAL_ATTEMPTS) {
        // Leave the records in place: the run quiesces with status 'error',
        // which a supervisor (or caller) can inspect and reassign.
        ctx.emit({ kind: 'heal:giveup', entity: e.id, system, failures: count });
        continue;
      }
      ctx.emit({ kind: 'heal:retry', entity: e.id, system, attempt: count });
      ctx.invalidate(e, system);
    }
  },
});

// --------------------------------------------------------------------- setup

/**
 * Spawns the team into a world: the supervisor and the researcher up front,
 * the `heal` watchdog as a global system. The writer is NOT spawned here — the
 * supervisor creates it at runtime. Models must be registered by the caller
 * under 'model:supervisor', 'model:researcher', and 'model:writer'.
 */
export function spawnTeam(world: World): { supervisor: EntityHandle; researcher: EntityHandle } {
  world.use(heal);
  const researcherEntity = world.spawn(researcher);
  const supervisorEntity = world.spawn(supervisor);
  return { supervisor: supervisorEntity, researcher: researcherEntity };
}
