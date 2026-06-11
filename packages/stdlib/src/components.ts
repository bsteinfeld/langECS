// Standard components for chat agents (SPEC §13, @langecs/stdlib).
// All values are plain JSON data (R3); behavior lives in named resources.

import {
  type ComponentType,
  defineComponent,
  defineTag,
  type Msg,
  type TagType,
} from '@langecs/core';

/** One tool invocation requested by the model (same shape as `Msg.toolCalls`). */
export type ToolCall = { id: string; name: string; args: unknown };

/** One actor-style inbox item; appending wakes the recipient's systems. */
export type InboxItem = {
  from: string | number;
  content: string;
  meta?: Record<string, unknown>;
};

/** Retry policy: at most `max` retries per failing system, exponential backoff from `baseMs`. */
export type RetryPolicyValue = { max: number; baseMs: number };

/** Conversation history; append reducer merges concurrent writers. */
export const Messages: ComponentType<Msg[]> = defineComponent<Msg[]>({
  name: 'Messages',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** System prompt passed to the model as `ModelRequest.system`. */
export const SystemPrompt: ComponentType<string> = defineComponent<string>({
  name: 'SystemPrompt',
});

/** Name of the world resource holding the `Model` (e.g. `'model:main'`). */
export const ModelRef: ComponentType<string> = defineComponent<string>({ name: 'ModelRef' });

/**
 * Tool names available to the agent. Implementations are world resources
 * registered under `tool:<name>` (see `registerTools`); entries may be bare
 * (`'calc'`) or full resource names (`'tool:calc'`).
 */
export const Tools: ComponentType<string[]> = defineComponent<string[]>({ name: 'Tools' });

/** Present while the agent owes the user an answer; `callLLM` removes it on a no-tool-call reply. */
export const MessageWaiting: TagType<'MessageWaiting'> = defineTag('MessageWaiting');

/** Tool calls awaiting execution. Plain component: single writer per step (R30). */
export const PendingToolCalls: ComponentType<ToolCall[]> = defineComponent<ToolCall[]>({
  name: 'PendingToolCalls',
});

/** Actor-style mailbox; append reducer, so `world.send(e, Inbox([...]))` wakes the recipient. */
export const Inbox: ComponentType<InboxItem[]> = defineComponent<InboxItem[]>({
  name: 'Inbox',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** Enables the `retry` system on an entity. */
export const RetryPolicy: ComponentType<RetryPolicyValue> = defineComponent<RetryPolicyValue>({
  name: 'RetryPolicy',
});
