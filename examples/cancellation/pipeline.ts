// A batch of long-running research jobs that can be stopped mid-flight.
//
// Two operational properties no other example covers:
//
//   world.cancel()  — an operator stops the batch while calls are in flight.
//                     Cooperative: the system forwards `ctx.signal` into its
//                     model call, so the abort reaches the provider request
//                     rather than merely ending the wait (R49/R50/R51).
//   timeoutMs       — one source hangs. Without a per-system deadline that
//                     single pair would hang the barrier for good; with one it
//                     becomes an ordinary SystemError the stdlib `retry` system
//                     heals like any other failure (R52).
//
// Everything here is plain ECS. Cancellation is a component, so the "stop
// button" is a query term (`Not(Cancelled)`) and nothing else about the design
// changes — no cancellation-aware scheduler, no special error channel.

import {
  Cancelled,
  createWorld,
  defineComponent,
  defineResource,
  defineSystem,
  delay,
  type Model,
  Not,
  SystemError,
  throwIfAborted,
  type World,
  type WorldOptions,
} from '@langecs/core';
import { RetryPolicy, retry } from '@langecs/stdlib';

export const WORLD_ID = 'cancellation';

/** The model every research pair calls. */
export const Researcher = defineResource<Model>('model:researcher');

/** One research job. `source` decides which fetch path it takes. */
export const Job = defineComponent<{ topic: string; source: 'fast' | 'flaky' }>({
  name: 'cancel.Job',
});

/** The finished write-up. Its absence is what keeps `research` matching. */
export const Notes = defineComponent<string>({ name: 'cancel.Notes' });

/**
 * The cancellable unit of work.
 *
 * `Not(Cancelled)` is the entire opt-in: after `world.cancel()` this pair stops
 * matching, so no new research starts. A job already in flight stops because the
 * system forwards `ctx.signal`. A job that ignored the signal would run to
 * completion and commit normally — that is the cooperative contract working as
 * specified, not a leak.
 *
 * A factory rather than a constant because `timeoutMs` has to suit the model
 * behind it: seconds for a live provider call, milliseconds for a scripted one.
 * A deadline shorter than a normal response turns every healthy call into a
 * timeout — which is exactly what happened the first time this demo was pointed
 * at a real model with the test's 250ms budget.
 */
export function researchSystem(timeoutMs: number) {
  return defineSystem({
    name: 'research',
    query: [Job, Not(Notes), Not(Cancelled)],
    // A deadline on the pair itself. The flaky source's first attempt never
    // returns; without this the step barrier would never commit, the run would
    // neither succeed nor fail, and `world.running` would stay true forever.
    timeoutMs,
    run: async (e, ctx) => {
      const { topic, source } = e.get(Job);

      // The engine already counts attempts for us: R31 appends an ErrorRecord
      // per failure and R32 clears them on success, so `SystemError` IS the
      // retry counter — no bespoke attempt component needed. The flaky source
      // hangs on its first attempt only.
      const attempted = (e.get(SystemError) ?? []).length > 0;
      if (source === 'flaky' && !attempted) {
        // A source that stopped responding without closing the connection. The
        // signal is honoured, so a cancel unblocks it immediately; absent a
        // cancel, `timeoutMs` is what rescues the run.
        await delay(60_000, ctx.signal);
      }

      const model = ctx.resource(Researcher);
      const result = await model.generate({
        messages: [{ role: 'user', content: `Research this in two sentences: ${topic}` }],
        // R49: the abort reaches the provider call, not just the await.
        signal: ctx.signal,
      });

      // Long post-processing loops should check the signal too, or a cancel
      // waits for them to finish.
      for (const _paragraph of result.message.content.split('\n')) throwIfAborted(ctx.signal);

      e.set(Notes, result.message.content);
    },
  });
}

export interface BuildOptions extends WorldOptions {
  model: Model;
  /**
   * Deadline for one research attempt. Seconds for a live provider, a few
   * hundred milliseconds for `scriptedModel`. `createWorld({ systemTimeoutMs })`
   * would set a world-wide default instead; this example puts it on the system
   * so the per-system form is the one on display.
   */
  timeoutMs?: number;
}

/** A world with `research` plus the stdlib `retry` system that heals timeouts. */
export function buildWorld(opts: BuildOptions): World {
  const { model, timeoutMs = 8_000, ...worldOpts } = opts;
  const world = createWorld({ id: WORLD_ID, ...worldOpts });
  world.register(Researcher, model);
  world.use(researchSystem(timeoutMs));
  // A SystemTimeoutError is an ordinary ErrorRecord, so the standard retry
  // pattern heals a hung system with no cancellation-specific machinery.
  world.use(retry);
  return world;
}

/** One entity per topic. `RetryPolicy` is what lets `retry` re-arm a timeout. */
export function spawnJobs(
  world: World,
  topics: { topic: string; source: 'fast' | 'flaky' }[],
): { id: number; topic: string }[] {
  return topics.map((job) => {
    const handle = world.spawn(Job(job), RetryPolicy({ max: 2, baseMs: 10 }));
    return { id: handle.id, topic: job.topic };
  });
}

/** What finished, what stopped — the partial-results view after a cancel. */
export function report(world: World): { topic: string; status: string; notes?: string }[] {
  return world.query(Job).map((e) => {
    const { topic } = e.get(Job) as { topic: string };
    const notes = e.get(Notes);
    if (notes !== undefined) return { topic, status: 'researched', notes };
    if (e.has(Cancelled)) return { topic, status: 'cancelled' };
    if (e.has(SystemError)) return { topic, status: 'failed' };
    return { topic, status: 'pending' };
  });
}
