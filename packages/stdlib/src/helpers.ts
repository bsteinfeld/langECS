// Conversation helpers (SPEC §13).

import type { EntityTarget, Msg, Run, World } from '@langecs/core';
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
