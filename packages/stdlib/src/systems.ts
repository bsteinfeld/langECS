// Standard systems (SPEC §13): the LLM↔tools dirty-trigger cycle, the
// human-approval dance, and SystemError-driven retry with backoff.

import {
  AwaitingHuman,
  Cancelled,
  defineSystem,
  type EntityReadView,
  type GuardCtx,
  HumanResponse,
  interrupt,
  type Model,
  type ModelRequest,
  type Msg,
  Not,
  SystemError,
} from '@langecs/core';
import {
  Messages,
  MessageWaiting,
  ModelRef,
  PendingToolCalls,
  RetryPolicy,
  SystemPrompt,
  type ToolCall,
  Tools,
} from './components';
import { bareToolName, lookupTool, toToolSpec } from './tools';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

/** Pending tool calls whose registered ToolDef has `needsApproval: true`. */
function approvalNeeded(e: EntityReadView<any>, ctx: GuardCtx): ToolCall[] {
  const calls: ToolCall[] = e.get(PendingToolCalls) ?? [];
  return calls.filter((call) => lookupTool(ctx, call.name)?.needsApproval === true);
}

/** Interprets the `world.resume(...)` value as an approval decision. */
function parseApproval(value: unknown): { approved: boolean; reason?: string } {
  if (value === true) return { approved: true };
  if (typeof value === 'object' && value !== null) {
    const v = value as { approved?: unknown; reason?: unknown };
    const out: { approved: boolean; reason?: string } = { approved: v.approved === true };
    if (typeof v.reason === 'string') out.reason = v.reason;
    return out;
  }
  return { approved: false };
}

/**
 * Calls the model whenever the conversation owes an answer (`MessageWaiting`).
 *
 * - Streams tokens to the live event stream via `ctx.emit({ kind: 'token', text })`
 *   when the model implements `stream` (R23); the final message still lands in
 *   `Messages` at the barrier.
 * - A reply with tool calls sets `PendingToolCalls` and keeps `MessageWaiting`;
 *   `executeTools` appends tool results to `Messages` (foreign dirt), which
 *   re-fires this system — the canonical LLM→tools→LLM cycle.
 * - A no-tool-call reply removes `MessageWaiting`: quiescence, answer delivered.
 * - Carries the standard `Not(Cancelled)` guard (R50) and forwards `ctx.signal`
 *   into the request (R49/R51), so `world.cancel()` and `timeoutMs` both reach
 *   the provider call rather than merely stopping the wait.
 */
export const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting, Not(Cancelled)],
  when: (e) => e.get(Messages).length > 0,
  run: async (e, ctx) => {
    const model = ctx.resource<Model>(e.get(ModelRef));
    const req: ModelRequest = { messages: e.get(Messages), signal: ctx.signal };
    const system = e.get(SystemPrompt);
    if (system !== undefined) req.system = system;
    const toolNames = e.get(Tools);
    if (toolNames !== undefined && toolNames.length > 0) {
      req.tools = toolNames.map((name) => {
        const tool = lookupTool(ctx, name);
        return tool ? toToolSpec(tool) : { name: bareToolName(name) };
      });
    }

    const result = model.stream
      ? await model.stream(req, (chunk) => {
          if (chunk.text !== undefined && chunk.text.length > 0) {
            ctx.emit({ kind: 'token', text: chunk.text });
          }
        })
      : await model.generate(req);

    const message = result.message;
    e.add(Messages, [message]);
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      e.set(PendingToolCalls, message.toolCalls);
    } else {
      e.remove(MessageWaiting);
    }
  },
});

/**
 * Interrupts the run before tools that require human approval execute.
 *
 * Fires on the same dirt as `executeTools` (PendingToolCalls newly matching) but
 * only when some pending call's ToolDef has `needsApproval` and no decision
 * exists yet; it appends a `tool-approval` interrupt to `AwaitingHuman`, which
 * unmatches `executeTools` (its `Not(AwaitingHuman)` term) and parks the run as
 * `'pending'`. `world.resume(entity, decision)` lifts the veto (R33).
 */
export const toolApproval = defineSystem({
  name: 'toolApproval',
  query: [PendingToolCalls, Tools, Not(Cancelled)],
  when: (e, ctx) =>
    !e.has(AwaitingHuman) && !e.has(HumanResponse) && approvalNeeded(e, ctx).length > 0,
  run: (e, ctx) => {
    const calls = approvalNeeded(e, ctx);
    e.add(AwaitingHuman, interrupt('tool-approval', { calls }).value);
  },
});

/**
 * Executes `PendingToolCalls` and appends each result to `Messages` as a
 * `tool` message (toolCallId/name preserved).
 *
 * The `when` guard defers to the approval flow: while a pending call needs
 * approval and no `HumanResponse` exists, the pair vetoes (consuming its dirt;
 * `toolApproval` then writes `AwaitingHuman`, whose `Not()` term keeps this
 * system unmatched until `world.resume`). A denial produces a tool-result
 * message saying the call was denied; calls that never needed approval still
 * execute. Tool errors become `Error: ...` tool messages so the model can react.
 * Consumes `HumanResponse` (R33 convention) and removes `PendingToolCalls`.
 */
export const executeTools = defineSystem({
  name: 'executeTools',
  query: [PendingToolCalls, Tools, Not(AwaitingHuman), Not(Cancelled)],
  when: (e, ctx) => approvalNeeded(e, ctx).length === 0 || e.has(HumanResponse),
  run: async (e, ctx) => {
    const calls = e.get(PendingToolCalls);
    const needing = new Set(approvalNeeded(e, ctx).map((call) => call.id));
    const response = e.get(HumanResponse);
    const decision = response === undefined ? { approved: true } : parseApproval(response.value);

    const results: Msg[] = [];
    for (const call of calls) {
      const base: Msg = {
        role: 'tool',
        content: '',
        toolCallId: call.id,
        name: bareToolName(call.name),
      };
      if (needing.has(call.id) && !decision.approved) {
        const reason = 'reason' in decision && decision.reason ? `: ${decision.reason}` : '.';
        base.content = `Tool call "${bareToolName(call.name)}" was denied by the human reviewer${reason}`;
        base.meta = { denied: true };
        results.push(base);
        continue;
      }
      const tool = lookupTool(ctx, call.name);
      if (tool === undefined) {
        base.content = `Error: tool "${call.name}" is not registered on this world.`;
        base.meta = { error: true };
        results.push(base);
        continue;
      }
      try {
        // The pair's signal reaches the tool (R51), so a cancelled world or an
        // elapsed timeout can stop an in-flight tool call too, not just a model call.
        const output = await tool.execute(call.args, { signal: ctx.signal });
        base.content = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
      } catch (err) {
        base.content = `Error: ${err instanceof Error ? err.message : String(err)}`;
        base.meta = { error: true };
      }
      results.push(base);
    }

    e.add(Messages, results);
    e.remove(PendingToolCalls);
    if (response !== undefined) e.remove(HumanResponse);
  },
});

/**
 * Retries failed systems with exponential backoff.
 *
 * `SystemError` is engine-written per failure (R31) and engine-cleared on a
 * later success (R32), so this system only counts records per failing system:
 * `attempts ≤ max` → wait `baseMs · 2^(attempts−1)` then `ctx.invalidate(e, system)`
 * (R24) to re-fire the failing pair; `attempts > max` → give up, leaving the run
 * quiescent with status `'error'`. A retried success auto-clears its records,
 * which either unmatches this system or re-fires it for the remaining failures.
 *
 * Carries `Not(Cancelled)` (R50): a cancelled world must not re-arm the work the
 * operator just stopped. Cancellation-induced failures write no `SystemError` at
 * all, so this guard covers the remaining case — errors that predate the cancel.
 */
export const retry = defineSystem({
  name: 'retry',
  query: [SystemError, RetryPolicy, Not(Cancelled)],
  run: async (e, ctx) => {
    const policy = e.get(RetryPolicy);
    const attempts = new Map<string, number>();
    for (const record of e.get(SystemError)) {
      attempts.set(record.system, (attempts.get(record.system) ?? 0) + 1);
    }
    let delay = 0;
    const targets: string[] = [];
    for (const [system, count] of attempts) {
      if (count > policy.max) continue; // exhausted: stay quiescent-with-error
      delay = Math.max(delay, policy.baseMs * 2 ** (count - 1));
      targets.push(system);
    }
    if (targets.length === 0) return;
    if (delay > 0) await sleep(delay);
    for (const system of targets) ctx.invalidate(e, system);
  },
});
