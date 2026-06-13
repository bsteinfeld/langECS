// The devtools-demo world: a small support desk built to light up every panel
// of the inspector — chat agents (Inspector's transcript view), a tool that
// needs human approval (Interrupts), a flaky worker with retry (SystemError +
// Timeline), and plain data entities (component editing).
//
// Everything here is deterministic by default: `policyModel()` is a scripted
// `Model` that decides from the conversation shape, so the GUI can send as
// many messages as it likes (unlike `scriptedModel`, it never runs out of
// turns). With OPENAI_API_KEY set, main.ts swaps in a real model instead.

import {
  createWorld,
  defineAgent,
  defineComponent,
  defineSystem,
  MemoryAdapter,
  type Model,
  type ModelRequest,
  type Msg,
  type PersistenceAdapter,
  type World,
} from '@langecs/core';
import { defineTool, RetryPolicy, reactAgent, retry, type ToolDef } from '@langecs/stdlib';

export const MODEL_RESOURCE = 'model:support';

// ---------------------------------------------------------------- demo data

export interface OrderRecord {
  id: string;
  item: string;
  amount: number;
  status: string;
}

const ORDERS: OrderRecord[] = [
  { id: '1042', item: 'Mechanical keyboard', amount: 42.5, status: 'delivered' },
  { id: '1043', item: 'Trackball mouse', amount: 89.0, status: 'shipped' },
  { id: '1044', item: 'Split ergonomic keyboard', amount: 199.0, status: 'processing' },
];

/** Reference data entity — try editing it live in the Inspector. */
export const OrderBook = defineComponent<OrderRecord[]>({ name: 'OrderBook' });

// ------------------------------------------------------------------- worker

/** Job queue for the background worker; appending wakes it (Inbox pattern). */
export const Jobs = defineComponent<string[]>({
  name: 'Jobs',
  reducer: (current, incoming) => [...current, ...incoming],
});

export const ProcessedJobs = defineComponent<string[]>({
  name: 'ProcessedJobs',
  reducer: (current, incoming) => [...current, ...incoming],
});

// First attempt per job fails — so the Timeline shows SystemError landing and
// the stdlib retry system healing it (R31/R32). Reset per world.
const failedOnce = new Set<string>();

const processJobs = defineSystem({
  name: 'processJobs',
  query: [Jobs],
  when: (e) => e.get(Jobs).length > 0,
  run: (e, ctx) => {
    const jobs = e.get(Jobs);
    const job = jobs[0];
    if (job === undefined) return;
    if (!failedOnce.has(job)) {
      failedOnce.add(job);
      throw new Error(`transient failure while processing "${job}" (retry will heal this)`);
    }
    ctx.emit({ kind: 'job-done', job });
    e.set(Jobs, jobs.slice(1));
    e.add(ProcessedJobs, [job]);
  },
});

const workerAgent = defineAgent({
  name: 'worker',
  components: [Jobs([]), ProcessedJobs([]), RetryPolicy({ max: 2, baseMs: 10 })],
  systems: [processJobs, retry],
});

// -------------------------------------------------------------------- tools

export const demoTools: ToolDef[] = [
  defineTool({
    name: 'lookupOrder',
    description: 'Look up an order by id.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    execute: (args) => {
      const { orderId } = args as { orderId: string };
      const order = ORDERS.find((o) => o.id === orderId);
      return order ?? { error: `no order with id ${orderId}` };
    },
  }),
  defineTool({
    name: 'issueRefund',
    description: 'Refund an order. Requires human approval.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
      required: ['orderId', 'amount'],
    },
    needsApproval: true,
    execute: (args) => {
      const { orderId, amount } = args as { orderId: string; amount: number };
      return { refunded: true, orderId, amount };
    },
  }),
];

// ------------------------------------------------------------- policy model

const orderIdIn = (text: string): string => /#?(\d{4})/.exec(text)?.[1] ?? '1042';

/**
 * A deterministic, stateless `Model`: decides from the conversation shape, so
 * any number of GUI-sent messages work. Refund requests run the full
 * lookupOrder → issueRefund (approval interrupt) → answer arc; anything else
 * gets a helpful canned reply.
 */
export function policyModel(): Model {
  const reply = (req: ModelRequest): Msg => {
    const messages = req.messages;
    let lastUserAt = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        lastUserAt = i;
        break;
      }
    }
    const lastUser = lastUserAt === -1 ? undefined : messages[lastUserAt];
    const toolResults = messages.slice(lastUserAt + 1).filter((m) => m.role === 'tool');
    const wantsRefund = /refund|broken|return/i.test(lastUser?.content ?? '');

    if (!wantsRefund) {
      return {
        role: 'assistant',
        content:
          "I'm the demo support agent. Ask me to refund an order (try: " +
          '"Please refund order #1042 — it arrived broken.") and watch the ' +
          'tool calls, approval interrupt, and traces light up.',
      };
    }
    const orderId = orderIdIn(lastUser?.content ?? '');
    if (toolResults.length === 0) {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call-lookup-${orderId}`, name: 'lookupOrder', args: { orderId } }],
      };
    }
    const denied = toolResults.some((m) => m.meta?.denied === true);
    if (denied) {
      return {
        role: 'assistant',
        content: `Understood — I won't refund order #${orderId}. Anything else I can help with?`,
      };
    }
    if (toolResults.length === 1) {
      const order = ORDERS.find((o) => o.id === orderId);
      return {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: `call-refund-${orderId}`,
            name: 'issueRefund',
            args: { orderId, amount: order?.amount ?? 0 },
          },
        ],
      };
    }
    const order = ORDERS.find((o) => o.id === orderId);
    return {
      role: 'assistant',
      content:
        `Done — I refunded $${(order?.amount ?? 0).toFixed(2)} for order ` +
        `#${orderId} (${order?.item ?? 'unknown item'}). It should appear in 3–5 business days.`,
    };
  };

  const usage = (req: ModelRequest, message: Msg) => ({
    inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4),
    outputTokens: Math.ceil(
      (message.content.length + JSON.stringify(message.toolCalls ?? '').length) / 4,
    ),
  });

  return {
    async generate(req) {
      const message = reply(req);
      return {
        message,
        usage: usage(req, message),
        finishReason: message.toolCalls ? 'tool_calls' : 'stop',
      };
    },
    async stream(req, onChunk) {
      const message = reply(req);
      for (const word of message.content.split(/(?<= )/)) {
        if (word.length > 0) onChunk({ text: word });
      }
      return {
        message,
        usage: usage(req, message),
        finishReason: message.toolCalls ? 'tool_calls' : 'stop',
      };
    },
  };
}

// -------------------------------------------------------------------- world

export interface DemoWorld {
  world: World;
  adapter: MemoryAdapter;
  support: { id: number };
  worker: { id: number };
}

/**
 * Builds the demo world. The model resource is NOT registered here — main.ts
 * registers it after `instrumentWorld` so the otel auto-wrap sees it (tests
 * register `policyModel()` directly).
 */
// Defined once at module scope: AgentDefs register their `agent:<name>` tag
// in the global component registry (R7/R34) — a second definition would throw.
const supportAgent = reactAgent({
  name: 'support',
  model: MODEL_RESOURCE,
  tools: demoTools,
  systemPrompt:
    'You are a support agent for a tiny keyboard shop. Look orders up before acting; ' +
    'refunds require the issueRefund tool.',
  retry: { max: 2, baseMs: 10 },
});

export function createDemoWorld(opts?: { persistence?: PersistenceAdapter }): DemoWorld {
  failedOnce.clear();
  const adapter = (opts?.persistence as MemoryAdapter | undefined) ?? new MemoryAdapter();
  const world = createWorld({ id: 'devtools-demo', persistence: adapter });

  const support = world.spawn(supportAgent);
  const worker = world.spawn(workerAgent);
  world.spawn(OrderBook(ORDERS));

  return { world, adapter, support, worker };
}
