// Conversation helpers (SPEC §13).

import type { EntityTarget, Msg, Run, RunResult, World } from '@langecs/core';
import { Messages, MessageWaiting } from './components';

/** A plain user `Msg`. */
export function userMessage(text: string): Msg {
  return { role: 'user', content: text };
}

/**
 * Appends a user message to the agent's `Messages`, raises `MessageWaiting`,
 * and drives the world to quiescence (`world.send` = external adds + run).
 */
export function sendMessage(world: World, agent: EntityTarget, text: string): Run {
  return world.send(agent, Messages([userMessage(text)]), MessageWaiting());
}

/** The most recent assistant message on the agent, or `undefined`. */
export function lastAssistant(world: World, agent: EntityTarget): Msg | undefined {
  const id = typeof agent === 'number' ? agent : agent.id;
  const messages = world.entity(id)?.get(Messages) ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role === 'assistant') return message;
  }
  return undefined;
}

/** `RunResult.pending` rendered for error messages: `entity 3 ('tool-approval')`. */
function describePending(pending: RunResult['pending']): string {
  return pending
    .map(
      ({ entity, interrupts }) =>
        `entity ${entity} (${interrupts.map((record) => `'${record.kind}'`).join(', ')})`,
    )
    .join('; ');
}

/** `RunResult.errors` rendered for error messages: system names + messages (R31). */
function describeErrors(errors: RunResult['errors']): string {
  return errors
    .flatMap(({ entity, records }) =>
      records.map(
        (record) =>
          `${record.system} (entity ${entity}) threw ${record.error.name}: ${record.error.message}`,
      ),
    )
    .join('; ');
}

/**
 * The one-liner Q&A path: `sendMessage` + await, returning the agent's reply
 * text. Resolves only fully-automatic turns that quiesce as `'done'` (R28);
 * every other outcome throws an `Error` explaining what happened and what to
 * do next:
 *
 * - `'pending'` — the world is awaiting human input: inspect `world.pending()`,
 *   answer with `world.resume(entity, value)`, then read `lastAssistant`.
 * - `'error'` — names each failing system and its `SystemError` message.
 * - `'limit'` — the step cap (`recursionLimit`) was hit before an answer.
 * - `'idle'` — no registered system matched the agent at all.
 *
 * @example
 * ```ts
 * const agent = world.spawn(reactAgent({ name: 'mathbot', model: 'model:main' }));
 * const answer = await ask(world, agent, 'What is 2 + 3?'); // 'The answer is 5.'
 * ```
 */
export async function ask(world: World, agent: EntityTarget, text: string): Promise<string> {
  const result = await sendMessage(world, agent, text);
  switch (result.status) {
    case 'done': {
      const reply = lastAssistant(world, agent);
      if (reply === undefined) {
        throw new Error(
          "ask() finished (status 'done') but the agent has no assistant message in Messages. " +
            'A system consumed MessageWaiting without appending a reply — check that the agent ' +
            'runs callLLM (reactAgent wires it) and that the model resource returns an ' +
            'assistant message; world.getTrace() shows what actually ran.',
        );
      }
      return reply.content;
    }
    case 'pending':
      throw new Error(
        `ask() cannot return an answer yet: the world is awaiting human input (status 'pending') — ` +
          `${describePending(result.pending)}. ask() resolves only fully-automatic turns. ` +
          'Inspect the interrupt(s) with world.pending(), answer with ' +
          'world.resume(entity, value), then read lastAssistant(world, agent) for the reply.',
      );
    case 'error':
      throw new Error(
        `ask() failed: the run quiesced with status 'error' — ${describeErrors(result.errors)}. ` +
          "The records stay in each entity's SystemError component until the failing system " +
          'succeeds (R32); world.getTrace() has the step-by-step story, and a RetryPolicy ' +
          'component enables the stdlib retry system.',
      );
    case 'limit':
      throw new Error(
        `ask() gave up: the run hit its step limit after ${result.steps} step(s) (status 'limit') ` +
          'before an answer arrived. Pending work is left intact, so world.run() resumes it. ' +
          'If the agent legitimately needs more steps, raise the cap with ' +
          'createWorld({ recursionLimit }) or world.run({ limit }) (default 50); otherwise a ' +
          'system cycle is failing to quiesce — world.getTrace() shows which pairs kept re-firing.',
      );
    case 'cancelled':
      throw new Error(
        "ask() was cancelled: the world carries Cancelled (status 'cancelled'), so the standard " +
          'Not(Cancelled) guard on callLLM/executeTools stopped the turn. This is the expected ' +
          'outcome of world.cancel(...) — no answer is coming. Remove the Cancelled component ' +
          'from the entities to un-cancel the world, then send again.',
      );
    case 'idle':
      throw new Error(
        "ask() got no answer: the run scheduled zero steps (status 'idle') — no registered " +
          'system matched the agent, so nothing could reply. Spawn the agent from an AgentDef ' +
          'that bundles the chat systems (e.g. reactAgent) or register them with world.use(...).',
      );
  }
}
